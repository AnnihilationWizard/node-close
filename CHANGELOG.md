# Changelog

## [1.1.0] - 2026-10-17

- Count tools a Node project installed under `node_modules`, such as esbuild, swc or turbo, as Node: an esbuild left on its own after its Node exited is now ended.
- Track the processes of background commands Claude starts. Once a background command stops, Node it left is ended within 30 seconds and Claude is told with its next shell command; when the session ends (not on `/clear` or a resume), its Node trees are ended. This is a fallback: Claude Code usually cleans these up itself.
- Add `/node-close`, which lists every orphaned Node on the machine with CPU use and run time, whoever started it, and `/node-close kill <PID ...>` or `kill all`, which ends listed ones when you run it yourself.
- Never list Claude Code itself or its ancestors as orphans.

## [1.0.0] - 2026-10-17

Initial release of node-close by AnnihilationWizard.

- After a Bash or PowerShell command finishes, end the Node processes it started that lost their parent, with their descendants: `SIGTERM`, then `SIGKILL` after one second (`taskkill /T` on Windows).
- Leave alone Node that ran before the command, processes a running parent still owns, and background or backgrounded commands.
- Keep processes a command starts on purpose (`&`, `nohup`, `disown`, `setsid`, `pm2`, `forever`, `--daemon`, `--detach`, `Start-Process`) and report their PIDs to Claude instead.
- Tell Claude which PIDs were ended, or which would not exit, and show a toast with the count.
- Skip commands that cannot start Node, so they cost no process listing.
- Marketplace file so the repository installs with `/plugin install node-close --marketplace AnnihilationWizard/node-close`.
- Tests for leftover detection, ending, escalation and what is left alone, run with `claude plugin test`.

Built on Claude Code's early-access function-hooks mod API.

[1.1.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.1.0
[1.0.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.0.0
