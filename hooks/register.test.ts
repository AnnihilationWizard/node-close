import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { isNode, leftovers, parsePs } from './register'

const ps = (...rows: [number, number, string][]) => rows.map(([pid, ppid, c]) => `  ${pid}  ${ppid} ${c}`).join('\n')

const CLAUDE: [number, number, string] = [70, 1, '/usr/local/bin/node /usr/local/bin/claude']
const SERVER: [number, number, string] = [77, 1, '/usr/local/bin/node /Users/me/app/server.js']
const SHELL = '/bin/zsh -c source ~/.claude/shell-snapshots/snapshot.sh && eval \'npx vitest run\''

const IDLE = ps(CLAUDE, SERVER)
// While `npx vitest run` runs: its shell, the runner and a worker.
const RUNNING = ps(CLAUDE, SERVER, [880, 70, SHELL], [900, 880, '/usr/local/bin/node /Users/me/p/node_modules/.bin/vitest run'], [901, 900, '/usr/local/bin/node /Users/me/p/node_modules/tinypool/dist/worker.js'])
// After it finished: the runner and its worker were re-parented to launchd, with an esbuild child.
const LEFT = ps(CLAUDE, SERVER, [900, 1, '/usr/local/bin/node /Users/me/p/node_modules/.bin/vitest run'], [901, 900, '/usr/local/bin/node /Users/me/p/node_modules/tinypool/dist/worker.js'], [902, 900, '/Users/me/p/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5 --ping'])

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
const world = (on: On, tables: string[], opts: { result?: object; onKill?: (argv: readonly string[]) => void } = {}) => {
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
    const stdout = tables[Math.min(i++, tables.length - 1)]!
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
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
  const stubborn = ps(CLAUDE, SERVER, [901, 900, '/usr/local/bin/node /Users/me/p/node_modules/tinypool/dist/worker.js'])
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
