# Changelog

## [1.3.1] - 2026-10-27

- Fix: in PowerShell, an `&` that begins a statement is the call operator (`& node x.js`, `& "C:\Program Files\nodejs\node.exe" x.js`), not a background one. Such commands were taken as keeping their processes on purpose, so their leftovers were reported instead of ended. A trailing `&` (PowerShell 7), `Start-Process`, and now `Start-Job` and `Start-ThreadJob` still keep them. Bash is read as before.
- Fix: a parent PID that a newer process has taken counts as a lost parent. Windows reuses PIDs soon, so an orphan whose old parent's PID went to an unrelated process was missed. A process that started after its child is no longer taken as its parent wherever parent links are followed; a real parent always starts first, so macOS and Linux are unchanged.
- On Windows, leftovers are ended with `taskkill /T /F` at once. `taskkill` without `/F` cannot end console processes such as `node.exe`, so the first try always failed and cost a second before the forced one.
- On Windows, PowerShell writes its listings in UTF-8, so command lines with non-ASCII paths, such as a Chinese user folder, are no longer garbled.

## [1.3.0] - 2026-10-19

- On Windows, a leftover must also carry this Claude Code's `CLAUDE_PID`, as on macOS and Linux, so a Node another session or you start while a command runs here is no longer ended. PowerShell compiles a small C# class with `Add-Type` that reads `CLAUDE_PID` from each candidate's environment block; 64-bit processes only.
- A Windows process the helper cannot open (32-bit, run as administrator, or another user's) is kept and reported to Claude instead of ended.
- If PowerShell refuses the helper, for example because antivirus blocks `Add-Type`, Windows falls back to the earlier rule and Claude is told once.
- Claude Code's own process is now the nearest `claude` or `claude.exe` above the listing, so a `cmd.exe` in between on Windows does not hide it, and an outer Claude Code is still never taken as its own.
- Fix: tracked background processes are matched by PID and start time. Since 1.1.0 they were matched by PID alone, so once a tracked process had exited and the system gave its PID to a new process, the 30-second check could end that new process if it was an orphaned Node, another session's included. A shell that replaces itself with Node keeps its PID and start, so it is still followed. Start times come from `ps` elapsed time (not its start column, whose format follows the locale) and from Windows `CreationDate`.

## [1.2.0] - 2026-10-19

- On macOS and Linux, a leftover must carry this Claude Code's `CLAUDE_PID`, which Claude Code sets in every shell it starts and its descendants keep, orphaned too. A Node that another session, an agent or you start while a command runs here is no longer ended; before, any Node that appeared on the machine and lost its parent counted. Background-command tracking follows the same rule.
- A Claude Code started by another session's command (a nested `claude -p`) takes only its own `CLAUDE_PID` as its own, not the outer session's.
- A leftover that carries no `CLAUDE_PID` at all is kept and reported to Claude with its PID and how to end it, so the mod does not go quiet if Claude Code stops setting the variable.
- Windows, which does not show another process's environment, keeps the earlier rule; the README says so.

## [1.1.2] - 2026-10-19

- `/node-close` shows run time on Windows, from each process's `CreationDate`; CPU use stays `-` there, and the listing and README say so.
- `/node-close kill` ends nothing and shows its usage when any argument is not a PID. Before, `kill 13004 Ended 1 Node process.` read the `1` as a PID.
- The `/node-close` heading counts only the orphans, with what runs beneath them counted apart, and the listing shows each one's processes indented beneath it.
- The listing is in a code block, so backslashes in Windows paths are kept and the columns stay aligned.
- On macOS and Linux, `/node-close kill <PID>` also ends what runs beneath that PID, as `taskkill /T` does on Windows.
- The README now warns that a Node another session starts while a command runs here can be counted as that command's leftover and ended.

## [1.1.1] - 2026-10-19

- Count Node apart from the helpers beneath it in every note, toast and `/node-close` listing. On Windows, a kept `node.exe` with its `conhost.exe` was reported as "2 Node processes"; it is now "1 Node process and 1 helper process".
- The plugin and marketplace descriptions mention esbuild and `/node-close`.

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

[1.3.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.3.0
[1.2.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.2.0
[1.1.2]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.1.2
[1.1.1]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.1.1
[1.1.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.1.0
[1.0.0]: https://github.com/AnnihilationWizard/node-close/releases/tag/v1.0.0
