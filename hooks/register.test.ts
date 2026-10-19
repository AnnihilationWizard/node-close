import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  SWEEP_MS,
  count,
  formatElapsed,
  grow,
  isNode,
  isNodeFamily,
  leftovers,
  mine,
  orphans,
  parseArgs,
  parseClaudePids,
  parseCimUsage,
  parsePs,
  tree,
} from './register'

const ps = (...rows: [number, number, string][]) => rows.map(([pid, ppid, c]) => `  ${pid}  ${ppid} ${c}`).join('\n')

const APP: [number, number, string] = [60, 1, '/Applications/Claude.app/Contents/MacOS/Claude']
const CLAUDE: [number, number, string] = [70, 60, '/usr/local/bin/node /usr/local/bin/claude']
const SERVER: [number, number, string] = [77, 1, '/usr/local/bin/node /Users/me/app/server.js']
const SHELL = '/bin/zsh -c source ~/.claude/shell-snapshots/snapshot.sh && eval \'npx vitest run\''

const IDLE = ps(APP, CLAUDE, SERVER)
// While `npx vitest run` runs: its shell, the runner and a worker.
const RUNNING = ps(APP, CLAUDE, SERVER, [880, 70, SHELL], [900, 880, '/usr/local/bin/node /Users/me/p/node_modules/.bin/vitest run'], [901, 900, '/usr/local/bin/node /Users/me/p/node_modules/tinypool/dist/worker.js'])
// After it finished: the runner and its worker were re-parented to launchd, with an esbuild child.
const LEFT = ps(APP, CLAUDE, SERVER, [900, 1, '/usr/local/bin/node /Users/me/p/node_modules/.bin/vitest run'], [901, 900, '/usr/local/bin/node /Users/me/p/node_modules/tinypool/dist/worker.js'], [902, 900, '/Users/me/p/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5 --ping'])

test('tells Node from a shell that runs it', () => {
  expect(isNode('/usr/local/bin/node x.js')).toBe(true)
  expect(isNode('node --max-old-space-size=4096 x.js')).toBe(true)
  expect(isNode('C:\\Program Files\\nodejs\\node.exe C:\\p\\x.js')).toBe(true)
  expect(isNode(SHELL)).toBe(false)
  expect(isNode('/usr/bin/nodemon x.js')).toBe(false)
})

test('counts new orphaned Node trees, not old ones or ones whose parent runs', () => {
  const before = new Set(parsePs(IDLE).map(p => p.pid))
  expect(leftovers(before, parsePs(RUNNING))).toEqual([])
  expect(leftovers(before, parsePs(LEFT)).map(p => p.pid).sort()).toEqual([900, 901, 902])
  // A Node that was already running before the command is not touched.
  expect(leftovers(new Set(parsePs(LEFT).map(p => p.pid)), parsePs(LEFT))).toEqual([])
})

test('on Windows, counts a tree whose parent no longer exists', () => {
  const before = new Set([4, 70])
  const procs = parsePs('4 0 System\r\n70 4 claude.exe\r\n900 6612 "C:\\Program Files\\nodejs\\node.exe" jest.js\r\n')
  expect(leftovers(before, procs).map(p => p.pid)).toEqual([900])
})

// The engine beneath: `ps` answers from the tables in turn (the last repeats),
// `kill` records its arguments and may change the table, Bash records what ran.
const world = (
  on: On,
  tables: string[],
  opts: {
    result?: object
    onKill?: (argv: readonly string[]) => void
    usage?: string
    env?: string
    isClockMocked?: boolean
  } = {},
) => {
  const kills: string[][] = []
  const ran: string[] = []
  const toasts: string[] = []
  let i = 0
  on('process.run', ($, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    if (argv[0] === 'kill') {
      kills.push([...argv])
      opts.onKill?.(argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[1] === 'eww') {
      return { value: { exitCode: 0, stdout: opts.env ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes('pid=,ppid=,pcpu=,etime=,command=')) {
      return { value: { exitCode: 0, stdout: opts.usage ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = tables[Math.min(i++, tables.length - 1)]!
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  if (opts.isClockMocked !== true) on('clock.sleep', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false, ...opts.result } } as never
  })
  return { kills, ran, toasts }
}

test('ends the Node processes a finished test run left', async ($, on) => {
  const tables = [IDLE, LEFT]
  const w = world(on, tables, { onKill: () => tables.push(IDLE) })
  const r = await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(w.ran).toEqual(['npx vitest run'])
  expect(w.kills).toEqual([['kill', '-TERM', '900', '901', '902']])
  expect(r.context?.join('\n')).toMatch(/left 3 Node processes running, now ended/)
  expect(w.toasts.join('\n')).toMatch(/closed 3 Node processes/)
})

test('kills outright the ones that ignore TERM', async ($, on) => {
  const stubborn = ps(APP, CLAUDE, SERVER, [901, 900, '/usr/local/bin/node /Users/me/p/node_modules/tinypool/dist/worker.js'])
  const tables = [IDLE, LEFT]
  const w = world(on, tables, { onKill: argv => tables.push(argv[1] === '-TERM' ? stubborn : IDLE) })
  const r = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(w.kills).toEqual([['kill', '-TERM', '900', '901', '902'], ['kill', '-KILL', '901']])
  expect(r.context?.join('\n')).toMatch(/now ended/)
})

test('leaves alone a command with no leftovers', async ($, on) => {
  const w = world(on, [IDLE, IDLE])
  const r = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(w.kills).toEqual([])
  expect(r.context ?? []).toEqual([])
})

test('keeps what a command backgrounds on purpose, and says so', async ($, on) => {
  const w = world(on, [IDLE, LEFT])
  const r = await $.tool.call({ tool: 'Bash', command: 'nohup node server.js > log 2>&1 &' })
  expect(w.kills).toEqual([])
  expect(r.context?.join('\n')).toMatch(/on purpose, so they were kept/)
})

test('does not touch a command still running in the background', async ($, on) => {
  const w = world(on, [IDLE, LEFT], { result: { backgroundTaskId: 'b1' } })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  expect(w.kills).toEqual([])
})

test('does not list processes for a command that cannot start Node', async ($, on) => {
  const w = world(on, [LEFT])
  await $.tool.call({ tool: 'Bash', command: 'git status && ls -la' })
  expect(w.kills).toEqual([])
  expect(w.ran).toEqual(['git status && ls -la'])
})

// The case from the field: `pnpm dev` ran as a background task; when it
// stopped, `tsx watch` and the esbuild its app child had started were both
// left to launchd, esbuild spinning.
const TSX = '/usr/local/bin/node /Users/me/p/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts'
const ESBUILD = '/Users/me/p/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.28.2 --ping'
const BG_SHELL = "/bin/zsh -c source ~/.claude/shell-snapshots/snapshot.sh && eval 'pnpm dev'"
const DEV = ps(APP, CLAUDE, SERVER, [880, 70, BG_SHELL], [890, 880, '/usr/local/bin/node /usr/local/bin/pnpm dev'], [900, 890, TSX], [910, 900, '/usr/local/bin/node src/index.ts'], [911, 910, ESBUILD])
const STRANDED = ps(APP, CLAUDE, SERVER, [900, 1, TSX], [911, 1, ESBUILD])

test('counts a Node project\'s tools, such as esbuild, as Node', () => {
  expect(isNodeFamily(ESBUILD)).toBe(true)
  expect(isNodeFamily(TSX)).toBe(true)
  expect(isNodeFamily('/usr/bin/python3 -m http.server')).toBe(false)
  expect(isNodeFamily(BG_SHELL)).toBe(false)
})

test('counts an esbuild left on its own after its Node exited', () => {
  const before = new Set(parsePs(IDLE).map(p => p.pid))
  const left = parsePs(ps(APP, CLAUDE, SERVER, [911, 1, ESBUILD]))
  expect(leftovers(before, left).map(p => p.pid)).toEqual([911])
})

test('lists orphaned Node anywhere, but never Claude Code or what it runs', () => {
  const listing: [number, number, string] = [999, 70, 'ps -axww -o pid=,ppid=,command=']
  const orphanedClaude = ps([70, 1, '/usr/local/bin/node /usr/local/bin/claude'], listing, [880, 70, BG_SHELL], [890, 880, 'node x.js'], [900, 1, TSX], [911, 1, ESBUILD])
  expect(orphans(parsePs(orphanedClaude)).map(p => p.pid).sort()).toEqual([900, 911])
})

test('ends what a stopped background command left', async ($, on) => {
  const clock = mock.clock(on)
  const tables = [IDLE, DEV, DEV]
  const w = world(on, tables, { result: { backgroundTaskId: 'b1' }, isClockMocked: true, onKill: () => tables.push(IDLE) })
  await $.tool.call({ tool: 'Bash', command: 'pnpm dev', run_in_background: true } as never)
  expect(w.kills).toEqual([])
  // Still running: the first sweep keeps it.
  await clock.advance(SWEEP_MS)
  expect(w.kills).toEqual([])
  // The task stops; its shell and pnpm go, tsx watch and esbuild are left.
  tables.push(STRANDED)
  await clock.advance(SWEEP_MS)
  await clock.advance(1000)
  expect(w.kills).toEqual([['kill', '-TERM', '900', '911']])
  expect(w.toasts.join('\n')).toMatch(/closed 2 Node processes a stopped background command left/)
  // Claude hears of it with the next shell command.
  const r = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(r.context?.join('\n')).toMatch(/a background command stopped but left 2 Node processes running, now ended: 900/)
})

test('ends a background command\'s Node when the session ends', async ($, on) => {
  const clock = mock.clock(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  const tables = [IDLE, DEV, DEV]
  const w = world(on, tables, { result: { backgroundTaskId: 'b1' }, isClockMocked: true, onKill: () => tables.push(IDLE) })
  await $.tool.call({ tool: 'Bash', command: 'pnpm dev', run_in_background: true } as never)
  const ended = $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } } as never)
  await clock.advance(500)
  await ended
  expect(w.kills[0]).toEqual(['kill', '-TERM', '890', '900', '910', '911'])
})

test('leaves background commands running after /clear', async ($, on) => {
  mock.clock(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  const w = world(on, [IDLE, DEV, DEV], { result: { backgroundTaskId: 'b1' }, isClockMocked: true })
  await $.tool.call({ tool: 'Bash', command: 'pnpm dev', run_in_background: true } as never)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
  expect(w.kills).toEqual([])
})

test('/node-close lists orphaned Node with CPU use, and only the person may end them', async ($, on) => {
  const w = world(on, [STRANDED], { usage: '  911  1  198.5  15:56:02 x\n  900  1  0.0  15:56:02 y' })
  const listed = await $.command.run({ command: 'node-close', args: '' } as never)
  // The person's own launchd-owned server is listed too, for them to judge.
  expect(listed.text).toMatch(/3 Node processes whose parent is gone/)
  expect(listed.text).toMatch(/911\s+198.5%\s+15:56:02/)
  // Raised by a plugin here, not typed by the person: refused.
  const asked = await $.command.run({ command: 'node-close', args: 'kill all' } as never)
  expect(asked.text).toMatch(/Only you can end/)
  expect(w.kills).toEqual([])
})

test('keeps tracking a background shell that replaced itself with Node', () => {
  const shell = parsePs(ps([880, 70, BG_SHELL]))
  const execd = parsePs(ps(APP, CLAUDE, [880, 70, '/usr/local/bin/node /usr/local/bin/pnpm dev'], [900, 880, TSX]))
  expect(grow(shell, execd).map(p => p.pid)).toEqual([880, 900])
})

test('counts Node apart from its helpers, such as a Windows console host', () => {
  const kept = parsePs('37264 6612 "C:\\Program Files\\nodejs\\node.exe" -e setTimeout(()=>{},120001)\r\n31028 37264 \\??\\C:\\Windows\\system32\\conhost.exe 0x4\r\n')
  expect(count(kept)).toBe('1 Node process and 1 helper process')
  expect(count(kept.slice(1))).toBe('1 helper process')
  expect(count([])).toBe('0 Node processes')
})

test('says how many are Node when it keeps a tree on Windows', async ($, on) => {
  const before = '4 0 System\r\n60 4 claude.exe\r\n'
  const after = before + '37264 6612 "C:\\Program Files\\nodejs\\node.exe" -e x\r\n31028 37264 C:\\Windows\\system32\\conhost.exe 0x4\r\n'
  world(on, [before, after])
  const r = await $.tool.call({ tool: 'Bash', command: "Start-Process node -ArgumentList '-e','x'" })
  expect(r.context?.join('\n')).toMatch(/left 1 Node process and 1 helper process running on purpose/)
})

test('reads Windows elapsed time from CreationDate seconds', () => {
  expect(formatElapsed(5)).toBe('00:05')
  expect(formatElapsed(3 * 3600 + 62)).toBe('03:01:02')
  expect(formatElapsed(2 * 86_400 + 3600)).toBe('2-01:00:00')
  expect(parseCimUsage('13004 954\r\n22304 953\r\n').get(13004)).toEqual({ cpu: '-', elapsed: '15:54' })
})

test('refuses /node-close kill arguments that are not PIDs', () => {
  expect(parseArgs('')).toEqual({ list: true })
  expect(parseArgs('kill all')).toEqual({ kill: 'all' })
  expect(parseArgs('kill 13004 22304')).toEqual({ kill: [13004, 22304] })
  // The previous output pasted back in: nothing is read as a PID.
  expect(parseArgs('kill 13004 Ended 1 Node process.')).toEqual({ usage: 'Not a PID: Ended Node process.' })
  expect(parseArgs('kill')).toEqual({ usage: 'Name the PIDs to end, or all.' })
  expect(parseArgs('kil 1')).toEqual({ usage: 'Unknown argument: kil' })
})

test('orders the listing as orphans with what runs beneath them', () => {
  const procs = parsePs(ps([13004, 1, 'node -e x'], [22304, 13004, 'conhost.exe 0x4'], [911, 1, ESBUILD]))
  expect(tree(procs).map(r => [r.proc.pid, r.depth])).toEqual([[13004, 0], [22304, 1], [911, 0]])
})

const CONHOST = '\\??\\C:\\Windows\\system32\\conhost.exe 0x4'

test('/node-close names orphans apart from what runs beneath them, in a code block', async ($, on) => {
  world(on, [ps(APP, CLAUDE, [13004, 1, '/usr/local/bin/node -e x'], [22304, 13004, CONHOST])])
  const listed = await $.command.run({ command: 'node-close', args: '' } as never)
  expect(listed.text).toMatch(/^1 Node process whose parent is gone, with 1 process beneath it/)
  expect(listed.text).toContain('```')
  expect(listed.text).toContain(`└─ ${CONHOST}`)
})

test('/node-close kill with a stray word ends nothing and shows usage', async ($, on) => {
  const w = world(on, [STRANDED])
  const r = await $.command.run({ command: 'node-close', args: 'kill 900 Ended 1' } as never)
  expect(r.text).toMatch(/Not a PID: Ended/)
  expect(r.text).toMatch(/Nothing was ended/)
  expect(w.kills).toEqual([])
})

// Another session's Node appears while a command runs here: both lose their
// parent, but only this Claude Code's (PID 70) carries CLAUDE_PID=70.
const LISTING: [number, number, string] = [990, 70, 'ps -axww -o pid=,ppid=,command=']
const OTHER = '/usr/local/bin/node /Users/me/other/server.js'
const MIXED = ps(APP, CLAUDE, SERVER, LISTING, [900, 1, '/usr/local/bin/node /Users/me/p/node_modules/.bin/vitest run'], [902, 900, ESBUILD], [950, 1, OTHER])
const ENV = [
  `  900 /usr/local/bin/node vitest run TERM=xterm CLAUDE_PID=70 CLAUDECODE=1`,
  `  902 ${ESBUILD}`, // spawned with a clean environment: goes with its parent
  `  950 ${OTHER} CLAUDE_PID=555 CLAUDECODE=1`,
].join('\n')

test('tells this Claude Code\'s processes from another session\'s', () => {
  const procs = parsePs(MIXED)
  const claudePids = new Map([[900, 70], [950, 555]])
  expect(mine(procs, procs.filter(p => [900, 902, 950].includes(p.pid)), claudePids).map(p => p.pid)).toEqual([900, 902])
  // A Node started outside Claude Code names no Claude Code: left alone.
  expect(mine(procs, procs.filter(p => p.pid === 950), new Map())).toEqual([])
  // Environments unreadable (Windows): every candidate is kept, as before.
  expect(mine(procs, procs.filter(p => p.pid === 950), undefined).map(p => p.pid)).toEqual([950])
  expect(parseClaudePids(ENV)).toEqual(new Map([[900, 70], [950, 555]]))
})

test('keeps and reports leftovers that carry no CLAUDE_PID, instead of going quiet', async ($, on) => {
  // As if Claude Code stopped setting CLAUDE_PID: the environment names none.
  const tables = [ps(APP, CLAUDE, SERVER, LISTING), MIXED]
  const w = world(on, tables, { env: `  900 node vitest run TERM=xterm\n  950 ${OTHER} TERM=xterm` })
  const r = await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(w.kills).toEqual([])
  expect(r.context?.join('\n')).toMatch(/carry no CLAUDE_PID, so it cannot tell whether this command started them; they were kept: 900 /)
})

test('does not take the Claude Code above a nested claude -p as its own', () => {
  // This Claude Code (70) runs beneath another session's (40), which started
  // a long-running Node of its own (950, CLAUDE_PID=40).
  const procs = parsePs(ps([40, 1, 'claude'], [70, 40, 'claude -p run the tests'], LISTING, [900, 1, 'node vitest run'], [950, 1, OTHER]))
  const claudePids = new Map([[900, 70], [950, 40]])
  expect(mine(procs, procs.filter(p => [900, 950].includes(p.pid)), claudePids).map(p => p.pid)).toEqual([900])
})

test('leaves another session\'s Node running when a command here finishes', async ($, on) => {
  const tables = [ps(APP, CLAUDE, SERVER, LISTING), MIXED]
  const w = world(on, tables, { env: ENV, onKill: () => tables.push(ps(APP, CLAUDE, SERVER, LISTING, [950, 1, OTHER])) })
  const r = await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(w.kills).toEqual([['kill', '-TERM', '900', '902']])
  expect(r.context?.join('\n')).toMatch(/now ended: 900 .*902 /)
  expect(r.context?.join('\n')).not.toMatch(/950/)
})
