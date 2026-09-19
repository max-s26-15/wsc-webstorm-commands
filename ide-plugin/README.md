# wsc IDE plugin

A tiny WebStorm plugin that adds one tool to the IDE's built-in MCP Server:
`debug_run_configuration(configurationName)` — start an existing run configuration with the **Debug** executor,
the same as its Debug button. The IDE's own `execute_run_configuration` only ever uses the Run executor, which is
why `wsc name:debug` has had to fall back to a Terminal tab with a bare Node inspector.

The tool starts the configuration with the Debug executor on the EDT and waits (up to 10 s) for the IDE to
confirm that the Debug tab exists; it answers `started a debug session for "<name>" (tab: …)`, or fails with an
error when the IDE never confirms.

`wsc` uses it by itself: on a `:debug` entry it asks the IDE for its tools, and when `debug_run_configuration`
is there it calls it instead of opening a Terminal tab with `--inspect-brk`. Without the plugin `wsc` keeps the
Terminal route and says how to get the plugin. An explicit `--target=terminal` is still honoured.

Because the IDE debugs the configuration itself, it also attaches to the child processes an npm script spawns
(`npm test`, `npm run dev` → gulp/nodemon), which the Terminal route could not: there the debugger stopped in
npm itself.

## Build

Needs a JDK (the one bundled with WebStorm works) and network access for Gradle. It builds against the
installed IDE, not a downloaded one.

```bash
cd ide-plugin
JAVA_HOME=/snap/webstorm/current/jbr ./gradlew buildPlugin
# -> build/distributions/wsc-ide-plugin-0.3.0.zip
```

Another install location: `-PwebstormPath=/path/to/webstorm`. The plugin declares `since-build 262`; the
MCP Server API it uses is not a documented stable API, so rebuild after a WebStorm update.

## Install and check

1. WebStorm → Settings → Plugins → ⚙ → **Install Plugin from Disk…** → pick the zip → restart the IDE.
2. `npm run mcp:probe` (from the repo root) should now show a ✓ on `debug_run_configuration`.
