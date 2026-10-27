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

// In PowerShell, an `&` that begins a statement is the call operator
// (`& node x.js`, `& "C:\Program Files\nodejs\node.exe" x.js`), not a
// background one; only a later `&` (PowerShell 7) backgrounds.
const CALL_OPERATOR = /(^|[;|{(\r\n]|&&)(\s*)&(?![&>])/g

// PowerShell jobs run on after the command too.
const STARTS_JOB = /\bstart-(thread)?job\b/i

// Whether a command of the shell tool `tool` leaves a process running on
// purpose.
export const keepsRunning = (command: string, tool: string) =>
  tool === 'PowerShell'
    ? KEEPS_RUNNING.test(command.replace(CALL_OPERATOR, '$1$2')) || STARTS_JOB.test(command)
    : KEEPS_RUNNING.test(command)

// `started`: when the process started, in seconds since the epoch, where the
// listing gives it.
export type Proc = { pid: number; ppid: number; command: string; started?: number }

// `ps` elapsed time, [[dd-]hh:]mm:ss, in seconds.
export const elapsedSeconds = (etime: string): number => {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = (clock ?? '').split(':').map(Number).reverse()
  return Number(days) * 86_400 + (parts[2] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[0] ?? 0)
}

// A Windows FILETIME (100 ns since 1601) in seconds since the epoch.
const fromFileTime = (filetime: string) => Math.floor(Number(filetime) / 10_000_000) - 11_644_473_600

// Lines of a process listing, read at `now` (milliseconds since the epoch):
// `pid ppid etime command` from `ps`, `pid ppid filetime command` from the
// PowerShell listing below (lines end in CRLF; 0 when Windows gives no
// CreationDate), or plain `pid ppid command`. `ps`'s elapsed time is used,
// not its start time, whose format follows the locale.
export const parsePs = (stdout: string, now = Date.now()): Proc[] =>
  stdout.split(/\r?\n/).flatMap(line => {
    const timed = /^\s*(\d+)\s+(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+(.*)$/.exec(line)
    if (timed)
      return [{ pid: Number(timed[1]), ppid: Number(timed[2]), command: timed[4] ?? '', started: Math.floor(now / 1000) - elapsedSeconds(timed[3]!) }]
    const filetime = /^\s*(\d+)\s+(\d+)\s+(\d{1,19})(?:\s+(.*))?$/.exec(line)
    if (filetime && (filetime[3] === '0' || filetime[3]!.length >= 17))
      return [
        {
          pid: Number(filetime[1]),
          ppid: Number(filetime[2]),
          command: filetime[4] ?? '',
          ...(filetime[3] === '0' ? {} : { started: fromFileTime(filetime[3]!) }),
        },
      ]
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

// Whether the executable is Claude Code: `claude`, or `claude.exe` on Windows.
const isClaude = (command: string) => /(^|[\\/"'])claude(\.exe)?["']?(\s|$)/i.test(executable(command))

// The Claude Code running this listing: the nearest `claude` above it (on
// Windows a `cmd.exe` can sit between), else its direct parent. Never a
// Claude Code further up, which a nested `claude -p` runs beneath.
export const ownClaude = (procs: readonly Proc[]): Set<number> => {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const own = new Set<number>()
  for (const listing of procs.filter(p => isListing(p.command))) {
    let found: number | undefined
    for (let up = byPid.get(listing.ppid), seen = new Set<number>(); up !== undefined && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      seen.add(up.pid)
      if (isClaude(up.command)) {
        found = up.pid
        break
      }
    }
    own.add(found ?? listing.ppid)
  }
  return own
}

// `ps` with each process's environment, on macOS and Linux.
export const psEnv = (pids: readonly number[]): string[] => ['ps', 'eww', '-o', 'pid=,command=', '-p', pids.join(',')]

// Windows does not list another process's environment, so a small C# class,
// compiled by PowerShell's Add-Type, reads CLAUDE_PID from each process's
// environment block (the PEB's process parameters). 64-bit processes only:
// a 32-bit (WOW64) one, or one it cannot open, is left out and so counts as
// carrying none. One line, with no single quote, so it passes inside a
// PowerShell single-quoted string as the listing's own command does.
export const WIN_ENV_CLASS =
  'using System; using System.Runtime.InteropServices; using System.Text; public static class NodeCloseEnv { ' +
  '[DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid); ' +
  '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); ' +
  '[DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow64); ' +
  '[DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read); ' +
  '[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int infoClass, byte[] info, int length, out int returned); ' +
  'static byte[] Read(IntPtr h, long address, int size) { byte[] buffer = new byte[size]; IntPtr read; ' +
  'return ReadProcessMemory(h, new IntPtr(address), buffer, new IntPtr(size), out read) && read.ToInt64() == size ? buffer : null; } ' +
  'public static string Get(int pid, string name) { if (IntPtr.Size != 8) return null; ' +
  'IntPtr h = OpenProcess(0x1000 | 0x0010, false, pid); if (h == IntPtr.Zero) return null; ' +
  'try { bool wow64; if (!IsWow64Process(h, out wow64) || wow64) return null; ' +
  'byte[] basic = new byte[48]; int returned; if (NtQueryInformationProcess(h, 0, basic, basic.Length, out returned) != 0) return null; ' +
  'byte[] parameters = Read(h, BitConverter.ToInt64(basic, 8) + 0x20, 8); if (parameters == null) return null; ' +
  'long block = BitConverter.ToInt64(parameters, 0); ' +
  'byte[] environment = Read(h, block + 0x80, 8); byte[] size = Read(h, block + 0x3F0, 8); ' +
  'if (environment == null || size == null) return null; ' +
  'long length = BitConverter.ToInt64(size, 0); if (length <= 0 || length > 1048576) return null; ' +
  'byte[] variables = Read(h, BitConverter.ToInt64(environment, 0), (int)length); if (variables == null) return null; ' +
  'foreach (string entry in Encoding.Unicode.GetString(variables).Split((char)0)) ' +
  'if (entry.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase)) return entry.Substring(name.Length + 1); ' +
  'return ""; } finally { CloseHandle(h); } } }'

// The PowerShell that prints `pid value` for each process whose environment
// it read (an empty value when CLAUDE_PID is absent).
export const winEnv = (pids: readonly number[]): string[] => [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition '${WIN_ENV_CLASS}'; ` +
    `foreach ($p in @(${pids.join(',')})) { $v = [NodeCloseEnv]::Get($p, 'CLAUDE_PID'); if ($null -ne $v) { "$p $v" } }`,
]

// Lines of `pid value` from winEnv; a line with no value names no CLAUDE_PID.
export const parseWinClaudePids = (stdout: string): Map<number, number> =>
  new Map(
    stdout.split(/\r?\n/).flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      return m ? [[Number(m[1]), Number(m[2])] as const] : []
    }),
  )

// Whether PowerShell refused to read environments the last time (Add-Type
// blocked, say by antivirus): leftovers then fall back to the older rule.
let isWindowsEnvRefused = false
let hasToldRefusal = false

// The CLAUDE_PID each process inherited: Claude Code sets it in every Bash
// shell it starts, and it stays with the shell's descendants, orphaned too.
export const parseClaudePids = (stdout: string): Map<number, number> =>
  new Map(
    stdout.split(/\r?\n/).flatMap(line => {
      const m = /^\s*(\d+)\s.*\sCLAUDE_PID=(\d+)(\s|$)/.exec(line)
      return m ? [[Number(m[1]), Number(m[2])] as const] : []
    }),
  )

// Of `candidates`, the ones this Claude Code started: a process whose
// CLAUDE_PID is the Claude Code that ran this listing (its direct parent,
// not a Claude Code further up: a `claude -p` started from another session
// runs beneath that session's), and what runs beneath one. Another
// session's or agent's Node names its own Claude Code, and one started
// outside Claude Code names none, so both are left alone. Where
// environments cannot be read, or no listing is found, every candidate is
// kept, as before.
//
// `unknown` holds the candidates neither marked as ours nor as another's:
// no CLAUDE_PID at or above them. They are kept and reported, not ended, so
// if Claude Code ever stops setting CLAUDE_PID the mod says so on every
// leftover instead of going quiet.
export const owners = (
  procs: readonly Proc[],
  candidates: readonly Proc[],
  claudePids: ReadonlyMap<number, number> | undefined,
): { ours: Proc[]; unknown: Proc[] } => {
  const own = ownClaude(procs)
  if (claudePids === undefined || own.size === 0) return { ours: [...candidates], unknown: [] }
  const byPid = new Map(candidates.map(c => [c.pid, c]))
  // The nearest CLAUDE_PID at or above `p` among the candidates.
  const claudeOf = (p: Proc): number | undefined => {
    for (let q: Proc | undefined = p, seen = new Set<number>(); q !== undefined && !seen.has(q.pid); q = byPid.get(q.ppid)) {
      seen.add(q.pid)
      const claude = claudePids.get(q.pid)
      if (claude !== undefined) return claude
    }
    return undefined
  }
  const ours: Proc[] = []
  const unknown: Proc[] = []
  for (const p of candidates) {
    const claude = claudeOf(p)
    if (claude === undefined) unknown.push(p)
    else if (own.has(claude)) ours.push(p)
  }
  return { ours, unknown }
}

export const mine = (
  procs: readonly Proc[],
  candidates: readonly Proc[],
  claudePids: ReadonlyMap<number, number> | undefined,
): Proc[] => owners(procs, candidates, claudePids).ours

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

// The listing's order: each orphan, then what runs beneath it, with how deep.
export const tree = (procs: readonly Proc[]): { proc: Proc; depth: number }[] => {
  const pids = new Set(procs.map(p => p.pid))
  const out: { proc: Proc; depth: number }[] = []
  const visit = (p: Proc, depth: number) => {
    out.push({ proc: p, depth })
    for (const child of procs) if (child.ppid === p.pid && child.pid !== p.pid) visit(child, depth + 1)
  }
  for (const root of procs.filter(p => !pids.has(p.ppid))) visit(root, 0)
  return out
}

// How far apart two listings may place one start time: each derives it from
// its own clock reading and whole seconds.
export const START_SLACK_S = 2

// Whether `a` and `b` started at the same moment, as far as both are known.
const sameStart = (a: Tracked, b: Tracked) =>
  a.started === undefined || b.started === undefined || Math.abs(a.started - b.started) <= START_SLACK_S

// The same process: same PID and start, or, where a start is unknown, same
// command line.
const isSame = (a: Tracked, b: Tracked) =>
  a.pid === b.pid && (a.started !== undefined && b.started !== undefined ? sameStart(a, b) : a.command === b.command)

// A process as tracked: PID, command line and start.
const toTracked = ({ pid, command, started }: Proc): Tracked => (started === undefined ? { pid, command } : { pid, command, started })

// The tracked processes still running, with every process now beneath one.
// Matched by PID and start, not command line: a shell that runs one command
// often replaces itself with it (`zsh -c 'node x.js'` becomes `node x.js`
// under the same PID and start), while a reused PID starts later.
export const grow = (tracked: readonly Tracked[], procs: readonly Proc[]): Proc[] => {
  const found = new Map(procs.filter(p => tracked.some(t => t.pid === p.pid && sameStart(t, p))).map(p => [p.pid, p]))
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
export const PS: readonly string[] = ['ps', '-axww', '-o', 'pid=,ppid=,etime=,command=']
export const CIM: readonly string[] = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) $($_.CommandLine)" }',
]
// `ps` with CPU use and elapsed time, for the `/node-close` listing.
export const PS_USAGE: readonly string[] = ['ps', '-axww', '-o', 'pid=,ppid=,pcpu=,etime=,command=']
// On Windows, seconds since each process started, from its CreationDate
// (absent for some system processes). Win32_Process has no CPU percentage.
export const CIM_USAGE: readonly string[] = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { "$($_.ProcessId) $([long]((Get-Date) - $_.CreationDate).TotalSeconds)" }',
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

export type Usage = { cpu: string; elapsed: string }

// Lines of `pid ppid pcpu etime command` from PS_USAGE.
export const parseUsage = (stdout: string): Map<number, Usage> =>
  new Map(
    stdout.split(/\r?\n/).flatMap(line => {
      const m = /^\s*(\d+)\s+\d+\s+([\d.]+)\s+(\S+)/.exec(line)
      return m ? [[Number(m[1]), { cpu: `${m[2]}%`, elapsed: m[3] ?? '' }] as const] : []
    }),
  )

// Seconds as `ps` writes elapsed time: [[dd-]hh:]mm:ss.
export const formatElapsed = (seconds: number) => {
  const two = (n: number) => String(n).padStart(2, '0')
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const clock = `${two(Math.floor((seconds % 3600) / 60))}:${two(seconds % 60)}`
  return days > 0 ? `${days}-${two(hours)}:${clock}` : hours > 0 ? `${two(hours)}:${clock}` : clock
}

// Lines of `pid seconds` from CIM_USAGE: elapsed time, no CPU use.
export const parseCimUsage = (stdout: string): Map<number, Usage> =>
  new Map(
    stdout.split(/\r?\n/).flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      return m ? [[Number(m[1]), { cpu: '-', elapsed: formatElapsed(Number(m[2])) }] as const] : []
    }),
  )

// CPU use and elapsed time by PID: both from `ps`, elapsed time alone on
// Windows.
const usage = async ($: EngineInterface): Promise<Map<number, Usage>> => {
  const isWindows = lister === CIM
  try {
    const { exitCode, stdout } = await $.process.run(isWindows ? CIM_USAGE : PS_USAGE)
    if (exitCode !== 0) return new Map()
    return isWindows ? parseCimUsage(stdout) : parseUsage(stdout)
  } catch {
    return new Map()
  }
}

// The CLAUDE_PID of each of `pids`, or undefined where environments cannot
// be read: on Windows, or when `ps` fails.
const claudePidsOf = async ($: EngineInterface, pids: readonly number[]): Promise<Map<number, number> | undefined> => {
  if (pids.length === 0) return undefined
  if (lister === CIM) {
    try {
      const { exitCode, stdout } = await $.process.run(winEnv(pids))
      isWindowsEnvRefused = exitCode !== 0
      return exitCode === 0 ? parseWinClaudePids(stdout) : undefined
    } catch {
      isWindowsEnvRefused = true
      return undefined
    }
  }
  try {
    const { exitCode, stdout } = await $.process.run(psEnv(pids))
    // `ps -p` exits 1 when some PIDs are gone; the rest are still listed.
    return exitCode === 0 || stdout.trim() !== '' ? parseClaudePids(stdout) : undefined
  } catch {
    return undefined
  }
}

// Of `candidates`, the ones this Claude Code started (see `mine`).
const owned = async (
  $: EngineInterface,
  procs: readonly Proc[],
  candidates: readonly Proc[],
): Promise<{ ours: Proc[]; unknown: Proc[] }> =>
  candidates.length === 0
    ? { ours: [], unknown: [] }
    : owners(procs, candidates, await claudePidsOf($, candidates.map(p => p.pid)))

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
  await update($, tracked, () => kept.map(toTracked))
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
    ...procs.filter(p => !known.some(k => k.pid === p.pid && sameStart(k, p))).map(toTracked),
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
  const isKept = keepsRunning(command, e.tool)

  // A background command, or one that outran its timeout or that the person
  // backgrounded, is still running: its processes are tracked, and ended once
  // the command stops and leaves them, or when the session ends.
  const isBackground =
    run_in_background === true ||
    typeof (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string'
  const after = (await list($)) ?? []
  if (isBackground) {
    if (!isKept) await track($, (await owned($, after, after.filter(p => !isBefore.has(p.pid)))).ours)
    return withNotes(ran)
  }

  // Only what this Claude Code started: a Node another session started in
  // the meantime has lost its parent too, but is not this command's.
  const { ours: left, unknown } = await owned($, after, leftovers(isBefore, after))
  const refused =
    isWindowsEnvRefused && !hasToldRefusal
      ? [
          `${$.plugin.name}: PowerShell refused the helper that reads which Claude Code started a process ` +
            `(Add-Type was blocked, possibly by antivirus), so on Windows any Node that appears during a command ` +
            `and loses its parent counts as its leftover, another session's included.`,
        ]
      : []
  if (refused.length > 0) hasToldRefusal = true
  const unsure =
    unknown.length === 0
      ? refused
      : [
          ...refused,
          `${$.plugin.name}: ${count(unknown)} appeared while this command ran and lost ${unknown.length === 1 ? 'its' : 'their'} parent, ` +
            `but carry no CLAUDE_PID, so it cannot tell whether this command started them; they were kept: ${describe(unknown)}. ` +
            `If they are this command's, end them with \`${killHint(unknown)}\`.`,
        ]
  if (left.length === 0) return withNotes(ran, unsure)

  if (isKept)
    return withNotes(ran, [
      `${$.plugin.name}: this command finished and left ${count(left)} running on purpose, so they were kept: ` +
        `${describe(left)}. End them with \`${killHint(left)}\` when they are no longer needed.`,
      ...unsure,
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
    ...unsure,
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
// What `/node-close` was asked: list, kill some PIDs, kill all, or nothing
// it understands. Anything after `kill` that is not a PID makes the whole
// request unclear, so nothing is ended.
export const parseArgs = (args: string): { list: true } | { kill: 'all' | number[] } | { usage: string } => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { list: true }
  if (words[0]?.toLowerCase() !== 'kill') return { usage: `Unknown argument: ${words[0]}` }
  const rest = words.slice(1)
  if (rest.length === 1 && rest[0]?.toLowerCase() === 'all') return { kill: 'all' }
  if (rest.length === 0) return { usage: 'Name the PIDs to end, or all.' }
  const bad = rest.filter(w => !/^\d+$/.test(w))
  if (bad.length > 0) return { usage: `Not a PID: ${bad.slice(0, 3).join(' ')}${bad.length > 3 ? ' ...' : ''}` }
  return { kill: rest.map(Number) }
}

const USAGE = `Usage: /${COMMAND} | /${COMMAND} kill <PID ...> | /${COMMAND} kill all`

const command: Hook<'command.run'> = async ($, e) => {
  const asked = parseArgs(e.args ?? '')
  if ('usage' in asked) return { text: `${asked.usage}\n${USAGE}\nNothing was ended.` }
  const found = await scan($)
  if (found === undefined) return { text: `Cannot list processes.` }

  if ('list' in asked) {
    if (found.length === 0) return { text: `No orphaned Node processes are running.` }
    const use = await usage($)
    const ordered = tree(found)
    const roots = ordered.filter(r => r.depth === 0).map(r => r.proc)
    const beneath = found.length - roots.length
    const rows = ordered.map(({ proc: p, depth }) => {
      const u = use.get(p.pid)
      const indent = depth > 0 ? `${'  '.repeat(depth - 1)}└─ ` : ''
      return `${String(p.pid).padStart(7)}  ${(u?.cpu ?? '-').padStart(6)}  ${(u?.elapsed ?? '-').padStart(11)}  ${indent}${short(p.command)}`
    })
    return {
      text: [
        `${count(roots)} whose parent is gone` +
          (beneath > 0 ? `, with ${beneath} process${beneath === 1 ? '' : 'es'} beneath ${roots.length === 1 ? 'it' : 'them'}` : '') +
          ` (not necessarily started by Claude):`,
        // A code block keeps the columns and the backslashes of Windows paths.
        '```',
        `    PID     CPU      ELAPSED  COMMAND`,
        ...rows,
        '```',
        ...(lister === CIM ? ['CPU use is not available on Windows.'] : []),
        `End them with \`/${COMMAND} kill <PID ...>\` or \`/${COMMAND} kill all\`.`,
      ].join('\n'),
    }
  }

  if (!PERSON.has(e.origin?.kind ?? ""))
    return { text: `Only you can end these processes; run \`/${COMMAND} kill\` yourself.` }

  const pids = asked.kill === 'all' ? found.map(p => p.pid) : asked.kill
  // A named PID takes what runs beneath it, as `taskkill /T` does on Windows.
  const named = new Set(pids.filter(pid => found.some(p => p.pid === pid)))
  let grew = true
  while (grew) {
    grew = false
    for (const p of found)
      if (!named.has(p.pid) && named.has(p.ppid)) {
        named.add(p.pid)
        grew = true
      }
  }
  const targets = found.filter(p => named.has(p.pid))
  const skipped = pids.filter(pid => !found.some(p => p.pid === pid))
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
