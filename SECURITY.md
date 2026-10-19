# Security Notes

node-close ends processes on your machine after shell commands Claude runs. These notes describe what it can reach; they do not establish a support SLA.

## What the mod does

- It hooks `tool.call` for Bash and PowerShell. Before and after a command that may start Node, it lists processes with `ps -axww -o pid=,ppid=,command=`, or PowerShell's `Get-CimInstance Win32_Process` on Windows.
- It ends only processes that are new since the command started, have lost their parent, and are Node or beneath a Node: `kill -TERM`, then `kill -KILL` for any still there after one second (`taskkill /T`, then `taskkill /T /F` on Windows).
- On macOS and Linux it also reads those candidates' environments with `ps eww -o pid=,command= -p <PIDs>`, and keeps only the ones whose `CLAUDE_PID` is the Claude Code running the mod, or that run beneath one. It takes nothing else from the environment: the rest is neither stored nor added to Claude's context. A candidate with no `CLAUDE_PID` at or above it is kept and reported to Claude by PID and command line. Windows does not show another process's environment, so there every candidate counts.
- For a background command, it lists processes again right after the command starts and keeps their PIDs and command lines in the session's state. Every 30 seconds while any are tracked, and when the session ends (not on `/clear` or a resume), it ends the Node trees among them that are left behind: orphaned ones during the session, all of them at its end.
- `/node-close` lists every Node, or executable under `node_modules`, whose parent is gone, with CPU use and elapsed time from `ps -axww -o pid=,ppid=,pcpu=,etime=,command=`. It never lists Claude Code itself or its ancestors. `/node-close kill` ends only listed PIDs, and only when you run the command yourself; a run from Claude, a plugin or the SDK is refused.
- It adds a note for Claude naming the PIDs and command lines it ended or kept, and shows a toast with the count.
- It does not read or write files, make network requests or change settings.

Command lines of the processes it ends are added to Claude's context. If a leftover process was started with a secret on its command line, that command line reaches the model.

On macOS and Linux, a Node that another Claude Code session, an agent or you start while a command runs here names a different Claude Code, or none, and is left alone. A process that drops `CLAUDE_PID` from its environment is matched only through an ancestor that kept it. On Windows, any Node that appears during the command and detaches at once still counts as a leftover; keep long-running work there in background commands, or start it with `Start-Process` or a process manager, which node-close leaves alone.

## Report a security concern

If this repository offers GitHub private vulnerability reporting, use the **Report a vulnerability** option on its [Security page](https://github.com/AnnihilationWizard/node-close/security). This document does not assume that the option is enabled.

If no private reporting option is available, open a minimal issue asking the maintainer to arrange a private channel. Do not publish exploit details, credentials or private code in that issue.

Include the affected version, Claude Code version, environment, steps to reproduce and impact. No response-time or supported-version guarantee is currently stated.
