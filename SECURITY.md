# Security

## What wsc runs

`wsc` starts processes on your machine, and two of its inputs usually arrive with a cloned repository:

- **`.idea/webstorm-commands.json`** — a preset entry with `commands` is shell text, run in a Terminal tab.
  `wsc` prints every such `name: command` line before each launch (also under `WSC_LOG_LEVEL=warn`),
  and refuses names and commands containing control characters, so the announcement cannot be forged or
  erased. Read it before the first `wsc` in a repository you did not write.
- **`.idea/runConfigurations/*.xml` and `.idea/workspace.xml`** — used to rebuild command lines for Terminal
  tabs and for `--fallback=terminal`. Every field is shell-quoted except a configuration's program
  arguments, which are shell text by design (as in the IDE).

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on
https://github.com/max-s26-15/wsc-webstorm-commands. Do not open a public issue.
You can expect a first answer within 7 days.
