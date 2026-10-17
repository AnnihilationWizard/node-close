# Contributing

Thank you for helping improve node-close. It is a small Claude Code mod written as a plugin of function hooks. Start with the [README](README.md).

## Report a bug

Use the [issue tracker](https://github.com/AnnihilationWizard/node-close/issues). Include:

- The node-close version, Claude Code version (`claude --version`) and operating system.
- The shell tool (Bash or PowerShell) and the command Claude ran.
- Which processes were ended that should have been kept, or kept that should have been ended, with their command lines from `ps` or Task Manager.
- Any transcript line that names `node-close`.

Never paste source code, command lines or paths you are not allowed to share. For security concerns, follow [SECURITY.md](SECURITY.md).

## Propose a change

Open an issue that describes the problem and the intended behavior before a broad change. Keep changes focused: the mod should only end processes the finished command started and left behind, never processes that ran before it or that a running parent still owns.

## Develop and verify

Run from the repository root:

```bash
claude plugin validate .
claude plugin test .
npx -p typescript@5 tsc -p .
```

The type-check needs the types Claude Code writes to `.claude-plugin/types/` the first time it loads the mod, for example with `claude --plugin-dir .`.

For behavior changes, add or update a test in `hooks/register.test.ts`, including a case for what must be left alone.

## Submit a pull request

- Explain the problem and the resulting behavior.
- List the checks you ran and their results.
- Update the README and CHANGELOG when behavior changes.
- Use a Conventional Commit message, such as `fix: keep processes started with setsid`.
