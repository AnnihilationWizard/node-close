# Changelog

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

[1.0.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.0.0
