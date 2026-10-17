import type { EngineInterface, Hook, Register } from 'claude-code'

// A shell command that may start Node: a package manager, a runner, a test
// tool, or a script. Other commands are not checked, so most commands cost
// no process listing.
const MAY_START_NODE =
  /\b(node|nodejs|npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack|tsx|ts-node|vitest|jest|mocha|ava|playwright|cypress|vite|next|nuxt|astro|turbo|nx|lerna|webpack|rollup|esbuild|tsc|eslint|prettier|make)\b|\.(c|m)?(js|ts)\b|\.sh\b/i

// A command that leaves a process running on purpose: a trailing or inner `&`
// (not `&&`, `&>`, `>&` or `|&`), or a tool that daemonizes. Its leftovers are
// reported, not ended.
const KEEPS_RUNNING =
  /(^|[^&>|])&(?![&>])|\b(nohup|disown|setsid|pm2|forever|daemon(ize)?)\b|start-process|--daemon\b|--detach\b/i

export type Proc = { pid: number; ppid: number; command: string }

// Lines of `pid ppid command`, from `ps` or from the PowerShell listing below
// (whose lines end in CRLF).
export const parsePs = (stdout: string): Proc[] =>
  stdout.split(/\r?\n/).flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? '' }] : []
  })

// Whether the executable is Node: the text before the first option ends a
// path segment named `node`, so `zsh -c node x.js` (the shell) is not counted.
export const isNode = (command: string) =>
  /(^|[\\/"'])node(js)?(\.exe)?["']?(\s|$)/i.test(command.split(/\s-/, 1)[0] ?? '')

// The processes a command left behind: new since `before`, in a tree of new
// processes whose top has lost its parent (re-parented to launchd/init, or on
// Windows pointing at a parent that no longer exists), and with Node at or
// above them in that tree, so a Node's esbuild or worker goes with it. A new
// process whose parent still runs (a parallel command, a background task) is
// not counted.
export const leftovers = (before: ReadonlySet<number>, procs: readonly Proc[]): Proc[] => {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const isNew = (p: Proc) => !before.has(p.pid)
  return procs.filter(p => {
    if (!isNew(p)) return false
    let hasNode = isNode(p.command)
    let top = p
    const seen = new Set([p.pid])
    for (;;) {
      const parent = byPid.get(top.ppid)
      if (parent === undefined || !isNew(parent) || seen.has(parent.pid)) break
      seen.add(parent.pid)
      top = parent
      hasNode ||= isNode(top.command)
    }
    const isOrphan = top.ppid === 1 || top.ppid === 0 || !byPid.has(top.ppid)
    return hasNode && isOrphan
  })
}

// How processes are listed: `ps` on macOS and Linux; on Windows, where `ps`
// is missing or is Git Bash's (no -x), PowerShell's Win32_Process.
export const PS: readonly string[] = ['ps', '-axww', '-o', 'pid=,ppid=,command=']
export const CIM: readonly string[] = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
]

// The listing that worked last, tried first next time.
let lister: readonly string[] | undefined

const tryList = async ($: EngineInterface, argv: readonly string[]): Promise<Proc[] | undefined> => {
  try {
    const { exitCode, stdout } = await $.process.run(argv)
    const procs = exitCode === 0 ? parsePs(stdout) : []
    return procs.length > 0 ? procs : undefined
  } catch {
    return undefined
  }
}

// Every process running, or undefined when no listing works.
const list = async ($: EngineInterface): Promise<Proc[] | undefined> => {
  for (const argv of lister === undefined ? [PS, CIM] : [lister, lister === PS ? CIM : PS]) {
    const procs = await tryList($, argv)
    if (procs !== undefined) {
      lister = argv
      return procs
    }
  }
  return undefined
}

const end = async ($: EngineInterface, pids: readonly number[], isForced: boolean) => {
  const argv =
    lister === CIM
      ? ['taskkill', '/T', ...(isForced ? ['/F'] : []), ...pids.flatMap(pid => ['/PID', String(pid)])]
      : ['kill', isForced ? '-KILL' : '-TERM', ...pids.map(String)]
  try {
    await $.process.run(argv)
  } catch {
    // Checked by listing again.
  }
}

// How long ended processes get to exit before they are killed outright.
export const GRACE_MS = 1000

// Ends the leftovers: TERM, a grace, then KILL for any still there. Resolves
// the ones that survived both.
const close = async ($: EngineInterface, targets: readonly Proc[]): Promise<Proc[]> => {
  const isTarget = (p: Proc) => targets.some(t => t.pid === p.pid && t.command === p.command)
  await end($, targets.map(p => p.pid), false)
  await $.clock.sleep(GRACE_MS)
  const stuck = ((await list($)) ?? []).filter(isTarget)
  if (stuck.length === 0) return []
  await end($, stuck.map(p => p.pid), true)
  return ((await list($)) ?? []).filter(isTarget)
}

const plural = (n: number) => `${n} Node process${n === 1 ? '' : 'es'}`

const describe = (procs: readonly Proc[]) =>
  procs.map(p => `${p.pid} (${p.command.length > 80 ? `${p.command.slice(0, 77)}...` : p.command})`).join(', ')

const killHint = (procs: readonly Proc[]) =>
  lister === CIM
    ? `Stop-Process -Id ${procs.map(p => p.pid).join(',')} -Force`
    : `kill ${procs.map(p => p.pid).join(' ')}`

// The shells whose commands are checked. PowerShell is Claude Code's shell
// tool on Windows; it is not in every build's tool types, so it is matched by
// name rather than by a typed matcher.
const SHELLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

const guard: Hook<'tool.call'> = async ($, e, next) => {
  if (!SHELLS.has(e.tool)) return next(e)
  const { command, run_in_background } = e as { command?: unknown; run_in_background?: unknown }
  if (typeof command !== 'string' || run_in_background === true || !MAY_START_NODE.test(command)) return next(e)

  const before = await list($)
  const ran = await next(e)
  if (before === undefined || ran.deny !== undefined) return ran

  // A command that outran its timeout, or that the person backgrounded, is
  // still running: its Node is not a leftover.
  if (typeof (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string') return ran

  const left = leftovers(new Set(before.map(p => p.pid)), (await list($)) ?? [])
  if (left.length === 0) return ran

  if (KEEPS_RUNNING.test(command)) {
    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `${$.plugin.name}: this command finished and left ${plural(left.length)} running on purpose, so they were kept: ` +
          `${describe(left)}. End them with \`${killHint(left)}\` when they are no longer needed.`,
      ],
    }
  }

  const stuck = await close($, left)
  const closed = left.length - stuck.length
  if (closed > 0) $.ui.toast(`${$.plugin.name}: closed ${plural(closed)} left by the last command`)
  return {
    ...ran,
    context: [
      ...(ran.context ?? []),
      stuck.length === 0
        ? `${$.plugin.name}: this command finished but left ${plural(left.length)} running, now ended: ${describe(left)}.`
        : `${$.plugin.name}: this command finished but left ${plural(left.length)} running; ${closed} ended, ` +
          `${stuck.length} would not exit: ${describe(stuck)}. End them with \`${killHint(stuck)}\`.`,
    ],
  }
}

export const register: Register = on => {
  // A hook that throws must not block the shell: fall through to the command.
  on('tool.call', guard).catch(($, e, next) => next(e))
}
