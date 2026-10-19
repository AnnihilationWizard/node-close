import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register, Timer } from 'claude-code'

import type { Tracked } from '../types'

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

// The executable part of a command line: the text before the first option.
const executable = (command: string) => command.split(/\s-/, 1)[0] ?? ''

// Whether the executable is Node: the text before the first option ends a
// path segment named `node`, so `zsh -c node x.js` (the shell) is not counted.
export const isNode = (command: string) => /(^|[\\/"'])node(js)?(\.exe)?["']?(\s|$)/i.test(executable(command))

// Whether the process is Node or a tool a Node project installed: an
// executable under `node_modules`, such as esbuild's service, swc or turbo.
export const isNodeFamily = (command: string) =>
  isNode(command) || /[\\/]node_modules[\\/]/i.test(executable(command))

const hasLostParent = (p: Proc, byPid: ReadonlyMap<number, Proc>) =>
  p.ppid === 1 || p.ppid === 0 || !byPid.has(p.ppid)

// The processes among `isOwn` that are left behind: in a tree of own processes
// whose top has lost its parent (re-parented to launchd/init, or on Windows
// pointing at a parent that no longer exists), or any tree when `isOrphanOnly`
// is false, and with Node or a Node project's tool at or above them in that
// tree, so a Node's esbuild or worker goes with it.
const strays = (procs: readonly Proc[], isOwn: (p: Proc) => boolean, isOrphanOnly = true): Proc[] => {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  return procs.filter(p => {
    if (!isOwn(p)) return false
    let hasNode = isNodeFamily(p.command)
    let top = p
    const seen = new Set([p.pid])
    for (;;) {
      const parent = byPid.get(top.ppid)
      if (parent === undefined || !isOwn(parent) || seen.has(parent.pid)) break
      seen.add(parent.pid)
      top = parent
      hasNode ||= isNodeFamily(top.command)
    }
    return hasNode && (!isOrphanOnly || hasLostParent(top, byPid))
  })
}

// The processes a command left behind: new since `before`, orphaned, Node or
// beneath Node. A new process whose parent still runs (a parallel command, a
// background task) is not counted.
export const leftovers = (before: ReadonlySet<number>, procs: readonly Proc[]): Proc[] =>
  strays(procs, p => !before.has(p.pid))

// A listing's own process: `ps` or PowerShell, with the arguments above.
const isListing = (command: string) => /pid=,ppid=|Get-CimInstance Win32_Process \| ForEach-Object/.test(command)

// The processes above a listing: Claude Code itself and what started it.
const ownChain = (procs: readonly Proc[], byPid: ReadonlyMap<number, Proc>): Set<number> => {
  const chain = new Set<number>()
  for (const p of procs.filter(q => isListing(q.command)))
    for (let up = byPid.get(p.ppid); up !== undefined && !chain.has(up.pid); up = byPid.get(up.ppid)) chain.add(up.pid)
  return chain
}

// Every orphaned Node on the machine, whoever started it: Node or a Node
// project's tool whose parent is gone, and everything beneath one. Claude
// Code itself is never one, even where its parent is launchd.
export const orphans = (procs: readonly Proc[]): Proc[] => {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const own = ownChain(procs, byPid)
  const found = new Map(
    procs
      .filter(p => p.pid > 1 && !own.has(p.pid) && isNodeFamily(p.command) && hasLostParent(p, byPid))
      .map(p => [p.pid, p]),
  )
  let grew = true
  while (grew) {
    grew = false
    for (const p of procs)
      if (!found.has(p.pid) && !own.has(p.pid) && found.has(p.ppid)) {
        found.set(p.pid, p)
        grew = true
      }
  }
  return [...found.values()]
}

const isSame = (a: Tracked, b: Tracked) => a.pid === b.pid && a.command === b.command

// The tracked processes still running, with every process now beneath one.
// Matched by PID alone: a shell that runs one command often replaces itself
// with it (`zsh -c 'node x.js'` becomes `node x.js` under the same PID).
export const grow = (tracked: readonly Tracked[], procs: readonly Proc[]): Proc[] => {
  const found = new Map(procs.filter(p => tracked.some(t => t.pid === p.pid)).map(p => [p.pid, p]))
  let grew = true
  while (grew) {
    grew = false
    for (const p of procs)
      if (!found.has(p.pid) && found.has(p.ppid)) {
        found.set(p.pid, p)
        grew = true
      }
  }
  return [...found.values()]
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
// `ps` with CPU use and elapsed time, for the `/node-close` listing.
export const PS_USAGE: readonly string[] = ['ps', '-axww', '-o', 'pid=,ppid=,pcpu=,etime=,command=']

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

export type Usage = { cpu: string; elapsed: string }

// Lines of `pid ppid pcpu etime command` from PS_USAGE.
export const parseUsage = (stdout: string): Map<number, Usage> =>
  new Map(
    stdout.split(/\r?\n/).flatMap(line => {
      const m = /^\s*(\d+)\s+\d+\s+([\d.]+)\s+(\S+)/.exec(line)
      return m ? [[Number(m[1]), { cpu: `${m[2]}%`, elapsed: m[3] ?? '' }] as const] : []
    }),
  )

// CPU use and elapsed time by PID, where `ps` gives them (not on Windows).
const usage = async ($: EngineInterface): Promise<Map<number, Usage>> => {
  if (lister === CIM) return new Map()
  try {
    const { exitCode, stdout } = await $.process.run(PS_USAGE)
    return exitCode === 0 ? parseUsage(stdout) : new Map()
  } catch {
    return new Map()
  }
}

const end = async ($: EngineInterface, pids: readonly number[], isForced: boolean) => {
  if (pids.length === 0) return
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

// Ends processes: TERM, a grace, then KILL for any still there. Resolves the
// ones that survived both.
const close = async ($: EngineInterface, targets: readonly Proc[], graceMs = GRACE_MS): Promise<Proc[]> => {
  const isTarget = (p: Proc) => targets.some(t => isSame(t, p))
  await end($, targets.map(p => p.pid), false)
  await $.clock.sleep(graceMs)
  const stuck = ((await list($)) ?? []).filter(isTarget)
  if (stuck.length === 0) return []
  await end($, stuck.map(p => p.pid), true)
  return ((await list($)) ?? []).filter(isTarget)
}

const plural = (n: number) => `${n} Node process${n === 1 ? '' : 'es'}`

// How many of `procs` are Node, and how many are helpers beneath one (a
// Windows console host, a shell): "1 Node process and 1 helper process".
export const count = (procs: readonly Proc[]) => {
  const node = procs.filter(p => isNodeFamily(p.command)).length
  const helpers = procs.length - node
  return [
    ...(node > 0 || helpers === 0 ? [plural(node)] : []),
    ...(helpers > 0 ? [`${helpers} helper process${helpers === 1 ? '' : 'es'}`] : []),
  ].join(' and ')
}

const short = (command: string) => (command.length > 80 ? `${command.slice(0, 77)}...` : command)

const describe = (procs: readonly Proc[]) => procs.map(p => `${p.pid} (${short(p.command)})`).join(', ')

const killHint = (procs: readonly Proc[]) =>
  lister === CIM
    ? `Stop-Process -Id ${procs.map(p => p.pid).join(',')} -Force`
    : `kill ${procs.map(p => p.pid).join(' ')}`

// The processes of background commands, kept across reloads in the session.
const tracked = atom({ plugin: 'node-close', key: 'tracked' } as const, [] as Tracked[])

// How often the processes of background commands are checked.
export const SWEEP_MS = 30_000

let sweeper: Timer | undefined

// Notes for Claude from a sweep, added to the next shell command's result.
let notes: string[] = []

// Ends what stopped background commands left: the tracked processes whose
// tree lost its parent. Keeps tracking the rest and what is beneath it.
const sweep = async ($: EngineInterface) => {
  const known = await read($, tracked)
  if (known.length === 0) return stopSweeping()
  const procs = await list($)
  if (procs === undefined) return
  const alive = grow(known, procs)
  const isAlive = (p: Proc) => alive.some(a => a.pid === p.pid)
  const left = strays(procs, isAlive)
  const stuck = left.length > 0 ? await close($, left) : []
  const kept = alive.filter(p => !left.some(l => l.pid === p.pid) || stuck.some(s => s.pid === p.pid))
  await update($, tracked, () => kept.map(({ pid, command }) => ({ pid, command })))
  if (kept.length === 0) stopSweeping()
  if (left.length === 0) return
  const ended = left.filter(p => !stuck.some(q => q.pid === p.pid))
  const closed = ended.length
  if (closed > 0) $.ui.toast(`${$.plugin.name}: closed ${count(ended)} a stopped background command left`)
  notes.push(
    stuck.length === 0
      ? `${$.plugin.name}: a background command stopped but left ${count(left)} running, now ended: ${describe(left)}.`
      : `${$.plugin.name}: a background command stopped but left ${count(left)} running; ${count(ended)} ended, ` +
        `${stuck.length} would not exit: ${describe(stuck)}. End them with \`${killHint(stuck)}\`.`,
  )
}

const startSweeping = ($: EngineInterface) => {
  sweeper ??= $.clock.every(SWEEP_MS, () => {
    sweep($).catch(() => {})
  })
}

const stopSweeping = () => {
  sweeper?.cancel()
  sweeper = undefined
}

const track = async ($: EngineInterface, procs: readonly Proc[]) => {
  if (procs.length === 0) return
  await update($, tracked, known => [
    ...known,
    ...procs.filter(p => !known.some(k => k.pid === p.pid)).map(({ pid, command }) => ({ pid, command })),
  ])
  startSweeping($)
}

// The shells whose commands are checked. PowerShell is Claude Code's shell
// tool on Windows; it is not in every build's tool types, so it is matched by
// name rather than by a typed matcher.
const SHELLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

const withNotes = <R extends { readonly context?: readonly string[] }>(ran: R, more: readonly string[] = []): R => {
  const all = [...notes, ...more]
  notes = []
  return all.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...all] }
}

const guard: Hook<'tool.call'> = async ($, e, next) => {
  if (!SHELLS.has(e.tool)) return next(e)
  const { command, run_in_background } = e as { command?: unknown; run_in_background?: unknown }
  if (typeof command !== 'string' || !MAY_START_NODE.test(command)) return withNotes(await next(e))

  const before = await list($)
  const ran = await next(e)
  if (before === undefined || ran.deny !== undefined) return withNotes(ran)
  const isBefore = new Set(before.map(p => p.pid))
  const isKept = KEEPS_RUNNING.test(command)

  // A background command, or one that outran its timeout or that the person
  // backgrounded, is still running: its processes are tracked, and ended once
  // the command stops and leaves them, or when the session ends.
  const isBackground =
    run_in_background === true ||
    typeof (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string'
  if (isBackground) {
    if (!isKept) await track($, ((await list($)) ?? []).filter(p => !isBefore.has(p.pid)))
    return withNotes(ran)
  }

  const left = leftovers(isBefore, (await list($)) ?? [])
  if (left.length === 0) return withNotes(ran)

  if (isKept)
    return withNotes(ran, [
      `${$.plugin.name}: this command finished and left ${count(left)} running on purpose, so they were kept: ` +
        `${describe(left)}. End them with \`${killHint(left)}\` when they are no longer needed.`,
    ])

  const stuck = await close($, left)
  const ended = left.filter(p => !stuck.some(q => q.pid === p.pid))
  const closed = ended.length
  if (closed > 0) $.ui.toast(`${$.plugin.name}: closed ${count(ended)} left by the last command`)
  return withNotes(ran, [
    stuck.length === 0
      ? `${$.plugin.name}: this command finished but left ${count(left)} running, now ended: ${describe(left)}.`
      : `${$.plugin.name}: this command finished but left ${count(left)} running; ${count(ended)} ended, ` +
        `${stuck.length} would not exit: ${describe(stuck)}. End them with \`${killHint(stuck)}\`.`,
  ])
}

// Reasons the process goes on after the session ends, its background
// commands with it: nothing is ended then.
const GOES_ON: ReadonlySet<string> = new Set(['clear', 'resume'])

// At the end of the session, every Node tree beneath a background command
// Claude started is ended, orphaned or not: nothing it started is meant to
// outlive the session.
const atEnd: Hook<'session.end'> = async ($, e, next) => {
  stopSweeping()
  if (GOES_ON.has(e.reason)) return next(e)
  const known = await read($, tracked)
  if (known.length === 0) return next(e)
  const procs = await list($)
  if (procs !== undefined) {
    const alive = grow(known, procs)
    const left = strays(procs, p => alive.some(a => a.pid === p.pid), false)
    if (left.length > 0) {
      await end($, left.map(p => p.pid), false)
      // Kill outright what has not exited, if the session's short exit bound
      // leaves time to look.
      if (next.budget.remainingMs > 1500) {
        await $.clock.sleep(500, { signal: next.signal })
        const stuck = ((await list($)) ?? []).filter(p => left.some(l => isSame(l, p)))
        await end($, stuck.map(p => p.pid), true)
      }
    }
  }
  await update($, tracked, () => [])
  return next(e)
}

const COMMAND = 'node-close'

// Origins where the person themself ran the command: only they may end
// processes Claude did not start.
const PERSON: ReadonlySet<string> = new Set(['composer', 'bridge'])

const scan = async ($: EngineInterface): Promise<Proc[] | undefined> => {
  const procs = await list($)
  return procs === undefined ? undefined : orphans(procs)
}

// `/node-close` lists every orphaned Node on the machine; `/node-close kill
// <PID ...>` or `kill all` ends listed ones, when the person runs it.
const command: Hook<'command.run'> = async ($, e) => {
  const words = e.args.trim().split(/\s+/).filter(Boolean)
  const found = await scan($)
  if (found === undefined) return { text: `Cannot list processes.` }

  if (words[0]?.toLowerCase() !== 'kill') {
    if (found.length === 0) return { text: `No orphaned Node processes are running.` }
    const use = await usage($)
    const rows = found.map(p => {
      const u = use.get(p.pid)
      return `  ${String(p.pid).padStart(7)}  ${(u?.cpu ?? '-').padStart(6)}  ${(u?.elapsed ?? '-').padStart(11)}  ${short(p.command)}`
    })
    return {
      text: [
        `${count(found)} whose parent is gone (not necessarily started by Claude):`,
        `      PID     CPU      ELAPSED  COMMAND`,
        ...rows,
        `End them with \`/${COMMAND} kill <PID ...>\` or \`/${COMMAND} kill all\`.`,
      ].join('\n'),
    }
  }

  if (!PERSON.has(e.origin?.kind ?? ""))
    return { text: `Only you can end these processes; run \`/${COMMAND} kill\` yourself.` }

  const all = words[1]?.toLowerCase() === 'all'
  const asked = all ? found.map(p => p.pid) : words.slice(1).map(Number).filter(Number.isInteger)
  if (asked.length === 0) return { text: `Usage: /${COMMAND} kill <PID ...> | all` }
  const targets = found.filter(p => asked.includes(p.pid))
  const skipped = asked.filter(pid => !targets.some(p => p.pid === pid))
  const stuck = targets.length > 0 ? await close($, targets) : []
  return {
    text: [
      targets.length > 0 ? `Ended ${count(targets.filter(p => !stuck.some(q => q.pid === p.pid)))}.` : `Nothing ended.`,
      ...(stuck.length > 0 ? [`Would not exit: ${describe(stuck)}.`] : []),
      ...(skipped.length > 0 ? [`Skipped, not an orphaned Node process: ${skipped.join(' ')}.`] : []),
    ].join('\n'),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'List orphaned Node processes; kill <PID ...> or kill all ends them',
      argumentHint: '[kill <PID ...> | kill all]',
    })
    // A reload keeps the tracked processes but not the timer.
    if ((await read($, tracked)).length > 0) startSweeping($)
    return next(e)
  })
  // A hook that throws must not block the shell: fall through to the command.
  on('tool.call', guard).catch(($, e, next) => next(e))
  on('session.end', atEnd).catch(($, e, next) => next(e))
  // A listing that fails says so rather than passing to an engine with no
  // command of this name.
  on('command.run', { command: COMMAND }, command).catch(() => ({ text: 'Could not list processes.' }))
}
