# node-close

<p align="center">
  <strong>Finished commands leave no Node behind.</strong><br>
  A Claude Code mod that ends the Node processes a finished command left running, such as test runners, their workers and esbuild, and finds orphaned Node however it was left with <code>/node-close</code>.
</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/Version-1.1.1-green.svg" alt="Version 1.1.1"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://code.claude.com/docs"><img src="https://img.shields.io/badge/Platform-Claude%20Code-D97757.svg" alt="Platform: Claude Code"></a>
  <a href="hooks/register.ts"><img src="https://img.shields.io/badge/Type-Function%20hooks%20mod-6E7681.svg" alt="Function hooks mod"></a>
  <a href="hooks/register.test.ts"><img src="https://img.shields.io/badge/Tests-19%20passing-3FB950.svg" alt="19 tests passing"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#development">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

![Side-by-side Claude Code session: on the left three finished test runs leave Node runners, workers and esbuild holding 940 MB; on the right each run's leftovers are closed when it finishes and a toast reports the count](docs/images/preview.svg)

*Illustration of a session before and after.*

When Claude runs tests or builds, the command can finish while Node keeps running: a test runner that never exits, a worker pool, an esbuild service. Claude Code moves on to the next step, and the leftovers pile up and hold memory. node-close checks right after each finished shell command and ends the Node processes that command started and left behind. It follows background commands too, and ends what they leave once they stop or the session ends.

Some leftovers outlive any hook: Claude Code killed outright, an IDE task, another tool. For those, `/node-close` lists every Node whose parent is gone, with its CPU use and run time, and `/node-close kill` ends the ones you choose.

> [!NOTE]
> node-close is built on Claude Code's function-hooks mod API, which is in early access and may change between releases.

## Features

- **Ends leftovers at once:** After a Bash or PowerShell command finishes, Node processes it started that are still running are sent `SIGTERM`, then `SIGKILL` after one second if they stay (`taskkill /T` on Windows).
- **Takes their tools too:** A Node's workers, and tools a Node project installed under `node_modules` such as esbuild, swc or turbo, go with it, even when the Node that started them has already exited.
- **Only what the command left:** A process counts only when it is new since the command started **and** has lost its parent, re-parented to launchd/init or, on Windows, pointing at a parent that no longer exists.
- **Keeps what you meant to keep:** Node running before the command, your own servers, other sessions and processes still owned by a running parent are never touched.
- **Follows background commands:** A background command's processes are tracked. Once it stops, any Node it left is ended within 30 seconds; when the session ends, its Node trees are ended. Claude Code usually cleans these up itself; this is a fallback for when it does not.
- **Respects on-purpose background work:** Commands with `&`, `nohup`, `disown`, `setsid`, `pm2`, `forever`, `--daemon`, `--detach` or `Start-Process` keep their processes; Claude is told the PIDs instead.
- **Tells Claude and you:** Claude gets the PIDs that were ended, and a toast shows the count.
- **Finds orphans from anywhere:** `/node-close` lists every Node whose parent is gone, with CPU use and run time, whoever started it; `/node-close kill` ends the ones you name.

| Situation | What node-close does |
| --- | --- |
| `npx vitest run` finishes, its runner and workers keep running | Ends them, tells Claude which PIDs |
| A process ignores `SIGTERM` | Kills it after one second; reports any that still remain |
| `nohup node server.js &` | Keeps it, tells Claude how to end it later |
| `npm run dev` with `run_in_background`, or moved to the background | Leaves it running; ends what it leaves once it stops, or at session end |
| An esbuild spinning after its `tsx watch` and session are gone | `/node-close` lists it with its CPU use; `/node-close kill <PID>` ends it |
| `git status`, `ls` and other commands that cannot start Node | Not checked |

## Install

In a Claude Code **terminal** session, run:

```
/plugin install node-close --marketplace AnnihilationWizard/node-close
```

1. Answer `y` to add the `github:AnnihilationWizard/node-close` marketplace.
2. Choose a scope. The **user** scope loads the mod in every session.
3. Claude Code confirms `Installed node-close. Plugin is now active.` The mod works in the current session without a restart.

To update later, run `claude plugin update`, then `/reload-plugins`.

<details>
<summary>Run from a local clone instead</summary>

```bash
git clone https://github.com/AnnihilationWizard/node-close.git
claude --plugin-dir ./node-close
```

To load a clone in every session, add it to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/node-close" }
}
```

</details>

## Usage

Once installed, there is nothing to configure. Ask Claude to run your tests; when the command finishes, any Node it left running is closed.

| Command | Effect |
| --- | --- |
| `/node-close` | List every orphaned Node and Node-project tool on the machine, with PID, CPU use, run time and command |
| `/node-close kill <PID ...>` | End the listed processes you name, with what runs beneath them |
| `/node-close kill all` | End every listed process |

`/node-close` lists processes Claude did not start too, such as a server you run under launchd, so check the list before `kill all`. Only you can run `kill`: when Claude or another plugin runs the command, it is refused.

### Limitations

- Only commands Claude runs through Bash or PowerShell are checked, not commands you run yourself.
- Nothing runs when Claude Code is killed outright (`SIGKILL`, a crash, the app force-quit), so its background commands can still be left behind. Use `/node-close` in the next session to find them.
- Background commands are checked every 30 seconds while any are tracked; on Windows each check takes about a second of PowerShell.
- A command is checked only when it may start Node: it names `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, a common test or build tool, a `.js`, `.ts` or `.sh` file, or `make`. A Node started by some other wrapper is not cleaned up.
- A Node that keeps its parent alive, for example under a daemon that stays running, is not counted as a leftover.
- An `&` inside quotes, such as in a URL, is read as background work, so that command's leftovers are reported instead of ended.
- Processes are listed with `ps` on macOS and Linux and with PowerShell's `Win32_Process` on Windows; if neither works, nothing is checked.
- The `/plugin install` command is available in terminal sessions only. A user-scope install also loads in the desktop app's Code tab.

## Development

```bash
claude plugin validate .   # manifest, marketplace file and hooks module
claude plugin test .       # hooks/*.test.ts against the engine
```

After Claude Code first loads the mod, it writes the API types to `.claude-plugin/types/` (git-ignored). Type-check against them with TypeScript 5.4 or newer:

```bash
npx -p typescript@5 tsc -p .
```

Run `claude --plugin-dir .` to try changes. In an interactive session the folder is watched, and saving a file reloads the mod.

## Project Structure

```text
.claude-plugin/   plugin.json manifest and marketplace.json
hooks/            hooks.json, the hooks module and its tests
types/            state contract for tracked background processes
docs/images/      README illustration
```

## Contributing

Bug reports and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an [issue](https://github.com/AnnihilationWizard/node-close/issues) or pull request, and follow [SECURITY.md](SECURITY.md) for security reports.

## License

[MIT License](LICENSE). Copyright © 2026 [AnnihilationWizard](https://github.com/AnnihilationWizard).
