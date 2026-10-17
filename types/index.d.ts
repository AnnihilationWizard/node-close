// A process node-close keeps track of: the PID and the command line it was
// seen with, so a reused PID is not mistaken for it.
export type Tracked = { pid: number; command: string }

declare module 'claude-code' {
  interface PluginState {
    'node-close': {
      // The processes of background commands Claude started this session, and
      // every process seen beneath them since: what a stopped background task
      // or the session's end may leave behind.
      tracked: Tracked[]
    }
  }
}
