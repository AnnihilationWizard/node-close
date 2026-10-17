# Security Notes

node-close ends processes on your machine after shell commands Claude runs. These notes describe what it can reach; they do not establish a support SLA.

## What the mod does

- It hooks `tool.call` for Bash and PowerShell. Before and after a command that may start Node, it lists processes with `ps -axww -o pid=,ppid=,command=`, or PowerShell's `Get-CimInstance Win32_Process` on Windows.
- It ends only processes that are new since the command started, have lost their parent, and are Node or beneath a Node: `kill -TERM`, then `kill -KILL` for any still there after one second (`taskkill /T`, then `taskkill /T /F` on Windows).
- It adds a note for Claude naming the PIDs and command lines it ended or kept, and shows a toast with the count.
- It does not read or write files, make network requests or change settings.

Command lines of the processes it ends are added to Claude's context. If a leftover process was started with a secret on its command line, that command line reaches the model.

A process that some other program starts during the command window and detaches at once could be counted as a leftover. Keep long-running work in background commands, or start it with `nohup`, `setsid` or a process manager, which node-close leaves alone.

## Report a security concern

If this repository offers GitHub private vulnerability reporting, use the **Report a vulnerability** option on its [Security page](https://github.com/AnnihilationWizard/node-close/security). This document does not assume that the option is enabled.

If no private reporting option is available, open a minimal issue asking the maintainer to arrange a private channel. Do not publish exploit details, credentials or private code in that issue.

Include the affected version, Claude Code version, environment, steps to reproduce and impact. No response-time or supported-version guarantee is currently stated.
