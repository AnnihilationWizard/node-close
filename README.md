# node-close

**Finished commands leave no Node behind.** After a shell command Claude runs (Bash, or PowerShell on Windows) finishes, the mod looks for Node processes that command started and left running, such as a test runner, its workers and their esbuild service, and ends them: `SIGTERM`, then `SIGKILL` after one second for any that stay (`taskkill /T` on Windows). Claude is told which PIDs were ended, and a toast shows the count.

Only processes that are new since the command started **and** have lost their parent (re-parented to launchd/init, or on Windows pointing at a parent that no longer exists) count. It leaves alone:

- Node processes that were running before the command, including other sessions and your own servers
- commands that run in the background or were moved there (`run_in_background`, a timeout, Ctrl+B)
- processes still owned by a running parent, such as a parallel command
- commands that keep something running on purpose (`&`, `nohup`, `disown`, `setsid`, `pm2`, `forever`, `--daemon`, `--detach`, `Start-Process`): their leftovers are reported to Claude, not ended

Commands that cannot start Node (no `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, a test or build tool, a `.js`/`.ts`/`.sh` file or `make`) are not checked, so they cost no process listing.

## Install

```
claude --plugin-dir /path/to/node-close
```

or add the folder to `CLAUDE_CODE_PLUGIN_DIRS`.

## Develop

```
claude plugin validate .
claude plugin test .
```
