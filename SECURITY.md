# Security

## What wsc runs

`wsc` starts processes on your machine, and two of its inputs usually arrive with a cloned repository:

- **`.idea/webstorm-commands.json`** — a preset entry with `commands` is shell text, run in a Terminal tab.
  `wsc` prints every such `name: command` line before each launch (also under `WSC_LOG_LEVEL=warn`),
  and refuses names and commands containing control characters, so the announcement cannot be forged or
  erased. Read it before the first `wsc` in a repository you did not write.
- **`.idea/runConfigurations/*.xml` and `.idea/workspace.xml`** — used to rebuild command lines for Terminal
  tabs (`:terminal`, `--target=terminal`, `:debug` without wsc Companion) and for `--fallback=terminal`.
  Every field is shell-quoted except two that are shell text by design, as in the IDE: a configuration's
  **program arguments** and a Node.js configuration's **Node parameters** (`node-parameters`). A
  hand-edited XML can put commands in either, and unlike custom `commands` they are not announced before
  the launch — `--dry-run` prints the exact command line. Read those two fields in a repository you did
  not write, or launch in the IDE's Run window (the default), where the IDE builds the command itself.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on
https://github.com/max-s26-15/wsc-webstorm-commands. Do not open a public issue.
You can expect a first answer within 7 days.
