// A process node-close keeps track of: the PID, the command line it was seen
// with, and when it started (seconds since the epoch, when the listing gives
// it), so a reused PID is not mistaken for it while a shell that replaces
// itself with Node still is.
export type Tracked = { pid: number; command: string; started?: number }

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
