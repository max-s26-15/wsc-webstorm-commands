# Changelog

Two things are released from this repository, each on its own version line: the `wsc`
command line tool (npm package `webstorm-commands`, tags `v*`) and the wsc Companion IDE
plugin (tags `plugin-v*`). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [cli 0.2.0] - 2026-MM-DD

### Added
- `wsc --stop` and `wsc --restart`: stop or restart what runs from the presets — every preset, the ones named with `--preset`, or single entries by name (custom commands too). A restart stays in the same Run, Debug or Terminal tab; an entry whose preset now gives it another mode is stopped and launched anew. Nothing is recorded: the IDE is asked what runs, every time. Needs wsc Companion 0.6.0.
- Tab completion offers the presets' entries after `--stop` / `--restart`.

### Changed
- Terminal tabs opened through wsc Companion carry a mark (the entry's kind, mode and inspector port), which is how `--stop` and `--restart` find them again.

## [plugin 0.6.0] - 2026-MM-DD

### Added
- `list_running` — the run configurations with a live process, and the Terminal tabs wsc opened with whether a command is running in them. What `wsc --stop` and `wsc --restart` ask.
- `stop_run_configuration` / `restart_run_configuration` — Stop and Rerun for a running configuration; the restart stays in the same Run or Debug tab, and a restarted debug session has its breakpoints muted.
- `stop_terminal_tab` / `restart_terminal_tab` — Ctrl-C in wsc's Terminal tab for an entry, and for a restart the command typed again in the same tab once the old one has stopped (5 s, otherwise an error and nothing typed).

### Changed
- `open_terminal_tab` takes an optional `kind`, `mode` and `debugPort`, and marks the tab with them, in memory only. Unmarked tabs — opened by an older wsc, by hand, or before an IDE restart — are invisible to the tools above.

## [cli 0.1.0] - 2026-MM-DD

First public release.

### Added
- Launch a set of WebStorm run configurations at once, each in its own Run/Debug or Terminal tab (`wsc a b:debug c:terminal`).
- Presets in `.idea/webstorm-commands.json`, edited with `wsc -c`, several at once with `--preset a b`, deleted with `--delete-preset`.
- Custom command entries in a preset (a named Terminal tab with no run configuration behind it), added (`n`), edited (`e`: rename; change, add, delete or reorder commands) and deleted from the `wsc -c` list.
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

### Fixed
- Use the debug session name rather than its deprecated `RunContentDescriptor` when matching sessions, avoiding an IDE error in split debugger mode.
- Avoid a `NullPointerException` on debug launch by muting breakpoints only after the Debug tab is confirmed, rather than during session initialization. A breakpoint can still hit before muting.

### Included (since 0.4.0 / 0.5.0)
- `debug_run_configuration` — a real Debug tab for `wsc name:debug`; sessions start with breakpoints muted.
- `open_terminal_tab` — real Terminal tabs (a pty, not pipes) for every Terminal tab wsc opens.
