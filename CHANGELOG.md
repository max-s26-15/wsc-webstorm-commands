# Changelog

Two things are released from this repository, each on its own version line: the `wsc`
command line tool (npm package `webstorm-commands`, tags `v*`) and the wsc Companion IDE
plugin (tags `plugin-v*`). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [cli 0.1.0] - 2026-MM-DD

First public release.

### Added
- Launch a set of WebStorm run configurations at once, each in its own Run/Debug or Terminal tab (`wsc a b:debug c:terminal`).
- Presets in `.idea/webstorm-commands.json`, edited with `wsc -c`, several at once with `--preset a b`, deleted with `--delete-preset`.
- Custom command entries in a preset (a named Terminal tab with no run configuration behind it).
- `--list`, `--dry-run`, `--target=terminal`, `--debug-port`, `--fallback=retry|terminal` (OS terminal tabs without the IDE).
- Tab completion for zsh and bash (`wsc --completion <shell>`).
- `wsc-mcp-probe`, a diagnostic for the IDE's MCP Server.

### Platform support
- Linux, macOS, Windows, tested in CI with Node 22, 24 and 26.
- On Windows, the Terminal routes (`:terminal`, `--target=terminal`, `:debug` without wsc Companion, custom commands) need a POSIX shell in the IDE's terminal: set Git Bash or WSL and run with `WSC_POSIX_TERMINAL=1`.

## [plugin 0.5.1] - 2026-MM-DD

First Marketplace release, as **wsc Companion** (`dev.wsc.ide`).

### Changed
- New plugin ID and name (was "wsc Debug Tool", `dev.wsc.debug-tool`): uninstall the old one once — the IDE treats them as different plugins.
- Declared compatible with WebStorm 2026.2 (build 262.*) only.

### Included (since 0.4.0 / 0.5.0)
- `debug_run_configuration` — a real Debug tab for `wsc name:debug`; sessions start with breakpoints muted.
- `open_terminal_tab` — real Terminal tabs (a pty, not pipes) for every Terminal tab wsc opens.
