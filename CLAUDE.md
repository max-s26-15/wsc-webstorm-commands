# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

`wsc` is a CLI that reads WebStorm run configurations over the IDE's built-in MCP Server and launches a
chosen set of them at once, each in its own Run/Debug or Terminal tab. The full build plan (11 phases) lives
in `.claude/scratch/wsc-plan.html` — read it before starting a new phase; it is the source of truth for
contracts, file lists, and manual acceptance checklists.

Currently implemented: **phases 1–10, all of them** — CLI skeleton, MCP client (port discovery + a typed
wrapper over `@modelcontextprotocol/sdk`), argument/name resolution, preset storage, the interactive
`-c/--configure` screen, execution, the retry / fallback prompt for an unreachable MCP Server, the
OS-terminal fallback that launches without the IDE at all, the final flag set (`-l/--list`, `README.md`,
the whole table pinned by `test/cli.integration.test.js`), and the phase-10 acceptance pass. `runCli`
walks the whole pipeline (args → project → preset → MCP → resolve → launch) and really opens tabs, on
both paths. The five-point acceptance checklist was run end to end against the live IDE on `demo-app`.
Since then: the user's own CLI commands in a preset (`commands` on an entry) — an entry with no run
configuration behind it, launched as a named Terminal tab.
Since then: Tab completion for zsh and bash (`wsc --completion <shell>`, `src/completion/`).
Since then: `wsc --delete-preset <name>` — a fifth intent that edits `.idea/webstorm-commands.json`
and never contacts the IDE.
What is left is user-triggered: `/code-review` over the whole diff before the first version tag.

## Commands

```bash
npm test              # node --test — full unit suite (test/*.test.js)
npm run test:watch    # same, in watch mode
npm run test:coverage # node --test --experimental-test-coverage
npm run typecheck     # tsc --noEmit -p jsconfig.json — checks JSDoc types in bin/, src/, scripts/
npm run mcp:probe     # node scripts/mcp-probe.js — manual diagnostic against a live WebStorm instance
node --test test/resolve.test.js                       # one test file
node --test --test-name-pattern='dry-run' test/cli.test.js  # tests whose name matches a pattern
(cd ide-plugin && JAVA_HOME=/snap/webstorm/current/jbr ./gradlew buildPlugin)  # optional Kotlin plugin → build/distributions/*.zip
npm link && wsc --help  # exercise the real entrypoint from any directory
```

There is no bundler/build step: the CLI runs straight from source (`"type": "module"`, plain ESM, no
transpilation). Types are JSDoc-only, checked by `tsc` in `--noEmit`/`allowJs`/`checkJs` mode against
`jsconfig.json`; `test/` and `test-utils/` are intentionally excluded from that check because test doubles
(fake streams, fake MCP sessions) are not meant to satisfy Node's/the SDK's full public types.

## Architecture

Orientation: everything below is a per-file decision log, long on purpose. The shape is one pipeline in
`src/cli.js` — args → project root → preset → MCP (or the `src/fallback/` no-IDE path) → resolve →
`buildExecutionPlan()` → `runExecutionPlan()` — and most bugs recorded here come from a seam between two of
those stages, so read the paragraph for the file you are touching before changing it.

Repo hygiene: `.claude/.claude/` is an accidental nested copy of `.claude/` (untracked, not gitignored) —
do not edit it or commit it. `ide-plugin/` is Kotlin/Gradle and has its own `README.md`; nothing in `npm test`
exercises it.

- `bin/wsc.js` — shebang entrypoint. Calls `runCli(process.argv.slice(2))` and does `process.exit(code)` — except that
  `argv[0] === '__complete'` goes to `src/completion/run.js` instead, each imported only on its own branch (see the
  completion paragraph below).
  No logic lives here beyond that one branch (which also swallows a failed load of `run.js`, so Tab stays silent);
  keep it that way so `src/cli.js` stays unit-testable without spawning a process. It has no static import at all,
  and `test/completionBoundary.test.js` pins that.
- `src/cli.js` — argument parsing (`node:util.parseArgs`) and the `runCli(argv): Promise<number>` contract
  every flag plugs into. Five intents live in it, and each one refuses the others' flags rather than
  half-honouring a command line: a launch, `--configure`, `--list`, `--completion`, and `--delete-preset`.
- `src/log.js` — `createLogger()`: leveled logging (`WSC_LOG_LEVEL`), `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`
  aware. Diagnostics go to stderr, `out()` is the only thing that writes to stdout, so `wsc --list` (and a
  `--dry-run` plan) stays pipeable. `color` is decided from **stderr**'s TTY-ness, not stdout's.
- `src/mcp/discovery.js` — `discoverPort()`: resolves the MCP Server's port. Order: `explicitPort`
  (`--mcp-port`) → `WSC_MCP_PORT` → best-effort range scan. The port is not published anywhere on disk by
  the IDE, so the scan is a last resort, not the primary path — see phase 0/2 in the plan for why.
- `src/mcp/client.js` — `connectMcp(port)` / `createMcpClient(session, opts)`: a thin wrapper around the SDK
  `Client` + `StreamableHTTPClientTransport` (`/stream` endpoint). Unwraps `CallToolResult`, converts
  `isError: true` responses into thrown `McpToolError`/`AmbiguousProjectError` (the IDE reports tool
  failures as *successful* responses — never trust a result without checking `isError` first), and injects
  `projectPath` into every call, since one MCP Server can serve multiple open IDE windows.
- **`--dry-run` guard.** `runCli` returns *before* calling `executePlan()` when the flag is set. The seam is
  filled in now, so the guard is load-bearing rather than precautionary: moving or inlining it starts real
  processes under `--dry-run`. Tests in `test/cli.test.js` ("--dry-run … execution seam") fail if it is
  removed, and another asserts that every flag declared in `OPTIONS` is actually read by `src/cli.js`, which
  catches the general "parsed but ignored" bug. The execution plan is built *ahead* of the guard on purpose,
  so `--dry-run` validates the launch too instead of only pretty-printing it. **The guard has two halves**:
  the terminal fallback branch returns before ever reaching this one, so `src/fallback/terminalFallback.js`
  carries its own — see the phase-8 section below.
- **`withMcpSession()` owns the session's lifetime, and the `return await` inside it.** In an async function
  a bare `return promise` inside `try/finally` runs the finally *before* the promise settles: close() then
  tears the transport down mid-work and every `execute_*` call comes back
  `MCP error -32000: Connection closed`. That shipped **twice** — once mid-launch (invisible until phase 6,
  because the seam did nothing async), once as `--configure` drew its first prompt (invisible only because
  that screen happens to need nothing from the IDE) — while each call site owned its own `try/finally` and
  had to remember. Phase 9 was about to be the third (`--list`), so the `try/finally` moved into one helper
  that does `return await body(client)`; callers now return a promise the ordinary way. Pinned by three
  tests: "the MCP session stays open until the launch has finished", "… while the configure screen is up",
  "… until the listing has been read". Reverting the `await` fails all three.
- **`reachMcp()` is the other half of that de-duplication**: discovery → the phase-7 prompt → an outcome of
  `port` / `without-ide` / `exit`. Shared by the launch, `--configure` and `--list` so `--fallback` cannot
  come to mean three slightly different things. What "without the IDE" *does* stays with the caller — OS
  terminal tabs for a launch, the `.idea/` catalogue for `--list` — and so does the label the prompt shows
  for it (`withoutIdeLabel`, passed in the opts bag beside `prompt`, because it shapes the screen and not
  the decision). An option that said "Continue without IDE tabs (OS terminal)" would promise a `--list`
  reader something pressing it does not do.
- `--project` is validated up front (`resolveProjectRoot()` in `src/cli.js`): it must exist, be a directory,
  and contain `.idea/`. Without that check a typo'd path reads as "no config file" — `readPresets` treats
  ENOENT as an empty config — and the run only breaks much later with the IDE's generic complaint. The
  auto-detected root cannot have that problem, since `findProjectRoot` only returns directories with `.idea/`.
- A `defaultPreset` naming a preset that does not exist is a *broken config*, distinct from an empty one:
  fatal when it was the only source of work, a warning when the user also named configurations on the command
  line. A project with no presets at all keeps the friendlier "nothing configured yet" message instead.
- `src/args.js` — `parseCliArgs()` (a `node:util.parseArgs` wrapper that turns every `ERR_PARSE_ARGS_*` into
  a `UsageError` → exit 2) and `splitNameMode()`/`parseRequests()` for positional `name[:run|:debug]` tokens.
  The "cut at the last colon when the suffix is run/debug" rule is **not sufficient on its own**: demo-app
  has a configuration literally named `api > repro:stale-job:debug`. So a token is first checked against
  the names the IDE reported (`isKnownName`) and only then eligible for splitting; `name:debug:debug` is the
  escape hatch for debugging a configuration whose name ends in `:debug`.
- `src/resolve.js` — pure resolution. `resolveName()` tries exact → case-insensitive → prefix, and each looser
  step must land on exactly **one** configuration (`addon` prefix-matches three in demo-app, so it throws
  `AmbiguousNameError` listing them rather than guessing). Unknown names throw `UnknownConfigurationError`
  with Levenshtein + substring suggestions. `buildLaunchPlan()` resolves the preset and the command line
  *before* returning anything, so a typo in the third argument cannot leave the first two already launched.
- **`--preset a b` launches several presets together.** `--preset` is the one `multiple: true` option, so
  `--preset a --preset b` works too. The catch is that `b` in `--preset a b` is a *positional*, and
  `wsc --preset watch test:coverage` has always meant "watch, plus the configuration test:coverage". So
  `parseCliArgs()` returns `presetUses` (each `--preset` value plus the positional indexes directly after it)
  and `splitPresetNames()` — called in `run()` only once the preset file is read — takes a following token as a
  preset **only if it is one**; the first that is not ends the run and stays a configuration (so a typo
  surfaces as "unknown configuration", not a confusing "unknown preset"). A name that is both a preset and a
  configuration reads as the preset; `wsc x --preset a` or `--preset a --dry-run x` keeps it a configuration.
  Entries are concatenated in the order typed and merged by `buildLaunchPlan()`'s existing `Map` rule (first
  position, last mode wins). `presetName` is then just a `' + '`-joined label for messages and the no-IDE
  hand-over. `--configure` edits one preset, so two are a usage error (exit 2). The early
  `typed`-vs-`positionals` naming in `run()` is deliberate: the raw positionals are all that exists before the
  file is read. Pinned by `test/args.test.js` (`splitPresetNames`) and `flag table — --preset` in
  `test/cli.integration.test.js`.
- **Preset and configuration names may collide with `Object.prototype`.** A preset called `constructor`, or
  a run configuration called `toString`, is legal input. Every lookup keyed by such a name uses
  `Object.hasOwn` (`hasPreset()` in the store, `answered()` in `configureLogic.js`) — a plain
  `obj[name] ?? fallback` returns an inherited function instead, which crashed
  `wsc --preset constructor` with a raw `TypeError`. Every *write* keyed by such a name goes through
  `Object.fromEntries` or a null-prototype object — a plain `obj[name] = …` invokes the `__proto__` setter,
  silently dropping the entry and mutating the object's prototype. Both directions are covered by regression
  tests in `test/presets.test.js`, `test/configureLogic.test.js`, `test/configure.test.js` and
  `test/cli.test.js`.
- `src/ui/configureLogic.js` — the pure half of `--configure`: `buildInitialSelection()` (IDE order, checked
  = current preset, plus `stale` for preset entries the IDE no longer reports), `pendingModeQuestions()`
  (only *newly* checked entries are asked about, so an edit is not a 13-question interview),
  `applyAnswersToPreset()` (existing entries keep their position and their unknown keys; new ones are
  appended) and `diffPreset()` for the summary.
- `src/ui/configure.js` — the thin half: drives `@inquirer/prompts` and calls the store. Refuses to run
  without a TTY on **both** stdin and stdout (in a pipe or CI a prompt waiting for input is
  indistinguishable from a hang), and treats `ExitPromptError`/`AbortPromptError` as an ordinary Ctrl-C —
  exit 130, nothing written.
- `src/ui/mcpUnavailablePrompt.js` — what happens when `discoverPort()` returns `null`. Split the same way
  `--configure` is: `resolveFallbackChoice()` holds every decision (the `--fallback` bypass, the retry loop,
  the mapping from an answer to an outcome) and is unit-tested with an injected prompt and clock, while
  `promptFallbackChoice()` is the one `select()` call. The plan's rule is **a message with two options, never
  a silent fallback** — quietly opening OS terminal windows instead of IDE tabs would be a different program
  than the one that was asked for. `MCP_SETUP_HELP` is the single copy of the phase-0 Settings path (MCP
  Server, Brave Mode, the port, `-Didea.mcp.server.force.port`); it is printed above the prompt *or* inside
  the give-up error, never both — the first live run of that branch printed it twice.
- **Retry bounds are asymmetric on purpose.** The interactive loop is unbounded (every attempt costs a
  keypress, so the user is the bound); `--fallback=retry` is capped at `RETRY_ATTEMPTS`, sleeping *before*
  each probe, because non-interactively nobody is there to stop an unbounded poll and a hang in CI looks
  exactly like a working command. Removing the bound hangs `test/mcpUnavailablePrompt.test.js` outright.
- **No TTY asks a different question here than in `--configure`.** Both refuse to draw a prompt unless stdin
  and stdout are *both* a terminal (dropping either half makes `test/cli.test.js` hang, which is the point),
  but `--configure` just exits 1, while an unreachable IDE ends with a message naming `--fallback=retry` and
  `--fallback=terminal` — a script has a documented way to state its answer in advance.
- `--fallback` is validated up front (`resolveFallback()`, exit 2) exactly like `--target`, and is
  deliberately **not** in `LAUNCH_ONLY_FLAGS`: `--configure` needs the IDE too, so `--fallback=retry` means
  the same thing there. Only `--fallback=terminal` is meaningless with `--configure` — there is no launch to
  move into a terminal — and that single pairing is its own usage error; `terminalAvailable: false` turns the
  prompt's second option into "give up" for the same reason.
- `runTerminalFallback()` in `src/cli.js` is phase 8's seam, and receives exactly what a launch needs that the
  IDE cannot supply: preset entries, the positional requests, the project root, the debug-port base. Those
  requests are parsed **without** `isKnownName`, because the list of real names is precisely what an
  unreachable MCP Server cannot provide — so `api > repro:stale-job:debug` splits syntactically on that
  path, and phase 8 owns saying so.
- `src/ui/promptCancel.js` — `isCancelled()` and `CANCELLED_EXIT_CODE` (130), shared by every screen that
  draws a prompt. Ctrl-C is an ordinary way to back out, and it must look identical wherever it happens.
- `--configure` runs **before** `buildLaunchPlan()` in `src/cli.js`, and bypasses the unknown-preset and
  broken-`defaultPreset` errors. All three are deliberate: a preset that is empty, misnamed, or points at a
  configuration the IDE has since dropped is exactly what the user opened the screen to fix, so none of it
  may be a precondition. `test/cli.test.js` pins this with a stale-preset case.
- **`src/exec/terminalShell.js` — Windows refuses the POSIX terminal routes, before the first call.** Every
  command wsc types into a Terminal tab is POSIX shell (`debugEnvPrefix()`'s expansion, `cd … &&`, the `.nvmrc`
  `PATH=` prefix, `shellQuote()`, custom `&&` chains), and WebStorm's terminal on Windows is PowerShell unless
  changed; the MCP API does not say which shell it runs. So `assertPosixTerminal(calls, {platform, env})` runs
  in `run()` right after `buildExecutionPlan()` and *before* the `--dry-run` guard: on `win32` any call through
  `execute_terminal_command` / `open_terminal_tab` throws `PosixTerminalRequiredError` (in `KNOWN_ERRORS`)
  naming those entries, unless `WSC_POSIX_TERMINAL=1` — the user's promise that the IDE terminal is Git Bash
  or WSL; any other value is not that promise. The run window and the plugin's `debug_run_configuration` are
  never refused (the IDE builds those command lines). It is a new class rather than `UnsupportedLaunchError`,
  whose message ("only knows how to do that for npm configurations") would be untrue here. `runCli` takes
  `deps.platform`; `fakeCliDeps()` defaults it to `linux`, because the plans its tests pin are POSIX text.
- `src/exec/inspectorPorts.js` — the one impure half of the debug path: `isPortFree()`/`findBusyPorts()`
  bind-test a port instead of connecting to it, because a bind reproduces exactly the `EADDRINUSE` Node's
  inspector would hit (including a listener bound to `0.0.0.0`, which a connect-probe on `127.0.0.1` also
  sees but for the wrong reason). Kept out of `planBuilder.js`, which is pure by contract.
- `src/exec/planBuilder.js` — pure: `PlanEntry[]` → `McpCall[]`. Decides which tool each entry needs and,
  for the terminal path, rebuilds the command line. Deviates from the plan's literal
  `buildExecutionPlan(resolved, runConfigs, target)`: `PlanEntry` already carries the resolved
  `RunConfigInfo`, so passing `runConfigs` again would mean a second, weaker lookup by name — it takes an
  options object instead, like `buildLaunchPlan` next door. Building is **atomic**, same as plan building:
  an entry that cannot be expressed as a command throws `UnsupportedLaunchError` before a single call is
  issued.
- **`:terminal` is a third *mode*, per entry — not a new `--target`.** `src/modes.js` is the one place the
  list `['run', 'debug', 'terminal']` and `DEFAULT_MODE` are spelled; `args.js`, `presets/store.js` and
  `ui/configureLogic.js` re-export them and `ui/configure.js` builds its `select()` choices from them, so
  the command line, the preset file and the `--configure` screen cannot drift (before that, `MODES` was
  duplicated in two files and the `'run' | 'debug'` literal in ten JSDoc types; `test/modes.test.js` pins
  the identity). `--target=terminal` is the same launch for the *whole run* and stays a separate flag:
  `usesTerminal(entry, target, {debugTool})` is `target === 'terminal' || mode === 'terminal' ||
  (mode === 'debug' && !debugTool)`, so a terminal entry takes the existing `.idea/`-backed `commandFor`
  path and needs no new machinery. It gets **no inspector port and no reroute note** (nothing is debugged
  and nothing was rerouted behind the user's back), which is why `debugSeen` counts `debug` entries only.
  Three seams that were easy to miss: `formatPlan()` pads the mode column to `max(5, longest mode)` — a
  fixed 8 would have re-aligned every pinned `--dry-run` text, and 5 would run `terminal` into the source;
  the launch header says `via run-window + terminal` for a mixed plan (it was untrue otherwise);
  `terminalEscapeHint('terminal')` names `:run`, because "drop `--target=terminal`" is advice that does
  nothing for an entry that asked for the terminal itself. On the no-IDE path every tab is already an OS
  terminal, so `:terminal` there **is** `:run` (`buildFallbackCommand` only ever special-cased `debug`);
  pinned by `runTerminalFallback — terminal entries`. The schema version stays 1: an older `wsc` reading
  `mode: "terminal"` stops with a `PresetConfigError` naming the file, which is the store's rule anyway.
  In `test/cli.integration.test.js` the terminal command line is matched by shape, not text — it may carry
  a `PATH=` for the project's `.nvmrc`, which depends on the machine.
- **Custom command entries — a preset entry with `commands` has no run configuration behind it.**
  `{ "name": "seed db", "mode": "terminal", "commands": ["npm i", "npm run seed"] }` is its own *kind*
  (`isCustomEntry` in `store.js`, `isCustomPlanEntry` in `resolve.js`), not a fourth mode: `mode` is always
  `terminal`, `MODES` is untouched (a `command` mode would have made `wsc foo:command` a token and a
  useless `select()` option) and the schema version stays 1, so an older `wsc` fails loudly instead of
  running something wrong. It exists only inside a preset — there is no way to call it by name from the
  command line, and `--target`/`:debug` do not touch it. `buildLaunchPlan()` keys its `Map` on
  `JSON.stringify([kind, name])`, so a run configuration called `custom:x` cannot swallow a custom entry
  named `x`; two custom entries of the same name merge by the usual rule. `customCommandLine()` joins with
  ` && ` and does **not** quote: the lines are shell text the user typed, like `config.args`, and `&&` is
  the "stop at the first failure" decision. A custom call reads no `.idea/`, gets no inspector port, never
  goes through `commandFor`, and `needsTerminalCommands()` ignores it; it is a Terminal call like the others,
  so it gets the same named session (`tabName = entry.name`). `announceCustomCommands()` prints each
  `name: command` line on **every** launch, not only `--dry-run`, as *one* `log.warn` call (header and lines
  joined with newlines) so `WSC_LOG_LEVEL=warn` cannot switch off the only statement of what shell text is
  about to run: `webstorm-commands.json` sits in `.idea/`
  and is usually committed, so a cloned repository would otherwise run shell text the first time `wsc` is
  typed. For the same reason the entry's `name` and every command are refused at parse time (and the
  name in `--configure`) if they hold a control character — `CONTROL_CHARACTERS` in `store.js`: C0 except
  tab, DEL, C1 — since both are printed raw and a newline could forge plan lines while an escape sequence
  could clear the announcement off the screen. The no-IDE path needs no catalogue for a preset made only of custom entries (the "WebStorm has
  saved no run configurations" error is raised only when a positional or a non-custom preset entry needs a catalogue),
  and `buildTabs()` never reads `entry.config` for them. In `--configure` the checkbox value of a custom
  entry is `customChoiceValue(name)`, distinct from a configuration name, because a hand-edited file can
  hold both under one name; an IDE that reports no configurations is no longer an error by itself (only the
  add-a-command loop is offered), but with *stale* preset entries it still is (exit 1) — rewriting the
  preset from an empty list would delete entries the IDE merely failed to show.
- **A Terminal tab is titled after the MCP *client* that opened it — so each one gets its own session.**
  `execute_terminal_command` has no tab-name parameter (schema read from the live IDE). Measured on
  WebStorm 2026.2.1: three calls from a client called `wsc` gave three tabs titled `wsc`; sessions called
  `probe-alpha` / `probe-beta` gave tabs with those titles; and printing a title escape sequence from the
  command (`printf '\033]0;name\007'`) changed nothing. So `buildExecutionPlan()` puts `tabName =
  entry.name` on every terminal call (`--target=terminal`, `:terminal`, and `:debug` without the plugin),
  and `runExecutionPlan()` makes such a call over `opts.connectAs(name)` — `connectMcp(port, {clientName})`,
  wired in `run()` — closed straight after in a `finally` (the `await` on the call is inside the `try`, the
  trap `withMcpSession()` documents). What was measured about closing is that the *command* keeps running
  (a file touched eight seconds after its session was closed still appeared), and — from a live launch of a
  custom command — that the *tab* stays open and keeps its title (`ngrok`) after `close()`.
  A bounded call now ends with a `close()` where it used to leave the session open. `close()` does not
  send the Streamable-HTTP session `DELETE` (`terminateSession()` is never called), so the IDE keeps each
  short-lived server-side session until it expires it — one per Terminal tab instead of one per run.
  A session that cannot be opened is **not** a failed launch — it falls back to the shared session with a
  warning that the tab will be titled `wsc`, because the name is a nicety and the command is the point.
  That refusal is remembered for the rest of the run (`naming` in `runExecutionPlan()`): one warning, and
  no further attempts, each of which would cost a connect timeout of up to ten seconds per tab. The same measurement showed the tab is
  separate per call, which is what `reuseExistingTerminalWindow: false` was already for. Only Terminal
  calls pay for the extra handshake; Run-window and Debug-tool calls keep the shared session. The OS
  terminal adapters already titled their tabs (`--title`, `tabtitle=`, AppleScript), so the no-IDE path
  needed nothing. Pinned by `runExecutionPlan — one named session per Terminal tab`, `connectMcp` "introduces
  itself as …" (reads the `initialize` body off a real socket) and the `tabName` block in
  `test/planBuilder.test.js`; `test/cli.integration.test.js` checks the wiring against the real `executePlan()` — only `connectMcp` is
  fake there — and the abort path (a transport error still closes the session that carried it) is pinned in
  `test/execute.test.js`.
- **`execute_terminal_command` is not a terminal — `open_terminal_tab` (the plugin's) is.** Measured on
  WebStorm 2026.2.3 with a diagnostic command sent through the IDE's tool: stdin, stdout and stderr are
  `pipe:[…]`, `[ -t 1 ]` is false, `TERM` is empty, `tty` says "not a tty". The tab only displays what the
  command prints, so a program that draws its own screen shows nothing (a custom `ngrok http 8000` showed
  just its stderr warning) and Ctrl-C in the tab cannot reach it; the tool's schema has no option for a
  pty. The plugin's `open_terminal_tab(tabName, command)` opens a real shell tab in the project root
  (`TerminalToolWindowManager.createShellWidget`, deprecated in 262 but in the terminal plugin's main jar —
  the replacement `TerminalToolWindowTabsManager` is experimental and sits in the optional content module
  `intellij.terminal.frontend`, which a `<depends>` plugin is not guaranteed to see) and types the command in.
  `run()` lists the IDE's tools once (`ideToolNames()`, a failed listing is "no plugin") and only when the
  plan has an entry that `usesTerminal()` would send to the terminal, so a run-window plan pays nothing;
  `buildExecutionPlan({terminalTool})` then builds every Terminal call through one `terminalCall()` helper —
  `terminalTabCall(name, command)` with the plugin (no `tabName`, so no named session, and no client-side
  timeout: it answers once the command is typed in), `terminalCommandCall()` + `tabName` without. Without
  the tool `PIPED_TERMINAL_NOTE` is warned once per run (`usesPipedTerminal(calls)`). Checked live with 0.4.0
  installed: the same `ngrok http 8000` custom command now draws its full screen in the tab (Ctrl-C was not
  separately checked). The README blocks showing `→ open_terminal_tab` were re-captured with it installed.
- **`ide-plugin/` — the optional WebStorm plugin that makes `:debug` a real Debug tab (and Terminal tabs real terminals).** A small Kotlin plugin
  (Gradle + IntelliJ Platform Gradle Plugin, built against the installed IDE — see `ide-plugin/README.md`) that
  registers two MCP tools: `open_terminal_tab` (the bullet above) and `debug_run_configuration(configurationName)`,
  which starts the configuration with
  `DefaultDebugExecutor` on the EDT and waits up to 10 s for the IDE's callback that the tab exists (an error,
  not a soft answer, when it never does). `runCli` asks `client.listTools()` — only when the plan has an entry
  that would otherwise go to the terminal, `:debug` included, and a failed listing means "no plugin", never a
  failed launch (`ideToolNames()` in `src/cli.js`) —
  and passes `debugTool` to `buildExecutionPlan()`/`needsTerminalCommands()`. With the tool a `:debug` entry
  becomes `debugConfigurationCall(name)`: no command, no inspector port, no reroute note, no `.idea/` read, and
  the IDE attaches to the child processes of an npm script too, which is what fixes p6-3 (the Terminal route
  debugged npm itself). Since 0.5.0 the session always starts with breakpoints muted (user's call: always, no
  flag or preset field) — `setBreakpointMuted(true)` from an `XDebuggerManager.TOPIC` `processStarted` listener
  matched on the run profile, plus a backstop on the confirmed tab; the CLI is untouched. The Terminal route has
  no IDE session, so nothing is muted there. Without it everything below is unchanged and the reroute note is followed by
  `DEBUG_PLUGIN_HINT`. An explicit `--target=terminal` still wins: the user named the terminal. Ports are handed
  out only to entries that use one, so "attach to port 9230" never names a port nothing listens on. MCP tools
  must be Kotlin `suspend` functions on a `McpToolset` class registered through the `mcpServer.mcpToolset`
  extension point; the API is not a documented stable one, so rebuild the plugin after an IDE update. Checked
  live: `wsc test:debug` → `started test (debug)`, and the IDE log shows a new `JavaScriptDebugProcess` session.
- **Without that plugin, `:debug` always goes through the Terminal window, whatever `--target` says.** There is no debug parameter
  anywhere in the IDE's MCP API (verified against the live tool schemas of WebStorm 2026.2.1:
  `execute_run_configuration` takes only `configurationName`/`waitForExit`/`timeout`/`programArguments`/
  `workingDirectory`/`envs`), and the `envs` override is gated behind `supportsDynamicLaunchOverrides`, which
  is `false` on every npm and Node.js configuration seen so far — including all 13 in the fixture. So the
  debugger has to be asked for inside the command (`debugEnvPrefix()`). The reroute is announced
  (`debugNote(ports)`, warned once per run, not once per entry) rather than done silently, and silently
  launching in plain run mode instead was rejected outright — it is the worst outcome available. The note is
  a **function of the assigned ports**, not a module-level constant: built from `DEBUG_PORT_BASE` at load
  time it kept announcing 9229 under `--debug-port 9400`, contradicting the commands printed beside it. It
  is built in a second pass over the calls (the last port is known only once every entry has one) and the
  identical string is put on every debug call, which is what keeps `executionNotes()`' deduplication working.
- **`:debug` on an npm configuration debugs npm, not the application (p6-3, measured).** With the preset
  launched live, `wsc web:debug` really did open a Terminal tab, really did listen on 9229, and
  `/json/list` there really did offer an attachable WebSocket target — but its `title` was
  `.../v14.21.3/bin/npm`, the process (`npm run dev`) had **no children** and stayed halted, so `gulp` was
  never spawned. `NODE_OPTIONS` is inherited by every `node` in the tree and the *first* one is npm's own
  CLI, which takes the port and breaks there. The plan's risk table already predicted this for wrappers
  that spawn node (nodemon, gulp) and gives the answer: use a configuration whose own script starts the
  debugger — demo-app's `api` runs `nodemon --inspect=9227`, so plain `wsc api` plus an attach to 9227
  is the working route. Documented in README's *Known limitations*; **not** fixed, because the fix is a
  design decision (inject the flag at the app rather than at the wrapper) and phase 10 is an acceptance
  pass. Whether a breakpoint then *stops* is the one step only a human clicking in the IDE can confirm.
- **One inspector port per `:debug` entry, counting up from 9229 (`DEBUG_PORT_BASE`).** A bare
  `--inspect-brk` means 9229 for everyone, so `wsc a:debug b:debug` started one debugger and printed
  `Starting inspector on 127.0.0.1:9229 failed: address already in use` into the second tab — reproduced in
  the IDE's own terminal. Ports are assigned in `buildExecutionPlan()` (only the plan knows how many debug
  entries there are), carried on `McpCall.debugPort`, and printed by the runner (`started x (debug, attach to
  port 9229)`) because that number is what WebStorm's "Attach to Node.js" has to be pointed at. The
  assignment is deterministic and is **not** silently shifted when a port turns out to be busy: a printed
  port that moves between runs is useless. Instead `src/exec/inspectorPorts.js` bind-tests the ports before
  launching and the CLI *warns*, and `--debug-port` moves the whole range. The check is best-effort by
  contract (the port is released again immediately, and the process starts inside the IDE a moment later),
  which is exactly why it warns instead of refusing.
- **`NODE_OPTIONS` is extended, never replaced.** The prefix is
  `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--inspect-brk=127.0.0.1:<port>"`: a plain
  `NODE_OPTIONS=--inspect-brk` prefix drops whatever the user's shell or project already exports
  (`--enable-source-maps`, `--max-old-space-size`, …) and the script then fails once it is already running.
  It has to be shell parameter expansion rather than a JS env object — the IDE runs the line in the
  terminal's own shell (zsh here, verified) and `execute_terminal_command` has no env parameter — so it must
  never be passed through `shellQuote()`, which would kill the expansion. The double quotes keep an
  inherited value containing spaces one word. `test/planBuilder.test.js` pins the *behaviour*, not the
  spelling: it runs the built prefix through a real `/bin/sh` and reads `NODE_OPTIONS` back.
- **`--configure` refuses every launch-only flag** (`LAUNCH_ONLY_FLAGS` in `src/args.js`: `--target`,
  `--debug-port`, `--dry-run`), the same way it already refused positional names — accepting them would
  silently ignore half of what the user typed. Checked before the IDE is contacted, exit 2. Only a flag that
  was actually passed counts, via `passedFlags()`/`Object.hasOwn`: `parseArgs` leaves an absent flag out of
  `values` entirely, so a `!== undefined` test would be right by accident rather than by construction, and a
  legitimately falsy value (`--preset ""`) still has to count as passed — pinned by "a flag with a falsy
  value still counts as one the user passed".
- **`src/list.js` — `--list`, and the four decisions in it (phase 9).**
  1. *Where the catalogue comes from.* `get_run_configurations` is the primary path, as the plan says, but
     `--list` goes through the same `reachMcp()` decision a launch does, so `--fallback=retry` polls and
     `--fallback=terminal` reads `.idea/` via phase 8's `readIdeaRunConfigs()`. "What can wsc launch here?"
     is answerable with the IDE shut down, and refusing to answer it would be the worse CLI. The two
     listings must never read alike — the disk one is the IDE's *saved* state — so it carries a warning
     naming `DISK_SOURCE` and saying a configuration not written out yet is missing, and its summary line
     says "saved by the IDE" against the other's "reported by the IDE". Pinned by "and says so, because that
     listing can be out of date", which asserts both halves; without the second assertion the two summaries
     were interchangeable and no test noticed.
  2. *`--list` is not a launch.* It refuses positional names, `--configure`, and `LIST_IGNORED_FLAGS`
     (`LAUNCH_ONLY_FLAGS` plus `--preset`) with exit 2, following `--configure`'s precedent rather than
     ignoring half a command line. `--preset` is in that set because a preset is wsc's selection *out of*
     the catalogue, and naming one changes nothing about what gets printed. `wsc --list web` prints all
     13 either way, which is exactly why it is refused instead of quietly accepted.
  3. *Output discipline.* The listing is the one thing on stdout (`log.out`) — this is the flag `src/log.js`'
     stream split exists for — and it is never coloured, because `color` is decided from **stderr**'s
     TTY-ness and colouring stdout would put escape sequences into a pipe whenever the two differ. An empty
     catalogue prints zero lines and exits 0, like `ls` on an empty directory, with the note on stderr.
  4. *Session lifetime.* `--list` holds an MCP session, so it goes through `withMcpSession()` like every
     other IDE call.
  `--list` also branches **before** `readPresets()`: the catalogue has nothing to do with presets, and
  failing on a missing or hand-broken `webstorm-commands.json` would break `--list` in exactly the project
  that needs it most. Pinned by "does not depend on the preset file, which it never uses".
- **`--delete-preset <name>` is a fifth intent that never contacts the IDE**, since which presets exist has
  nothing to do with it: no `reachMcp()`, no `connectMcp`, no `--fallback`, no TTY requirement, no
  confirmation prompt — it only reads and writes `.idea/webstorm-commands.json`. `DELETE_PRESET_IGNORED_FLAGS`
  (`src/args.js`) is `Object.keys(OPTIONS)` minus `delete-preset`/`project`/`help`/`version`/`completion`,
  rather than a spelled-out list, so a flag added later is refused by default instead of silently ignored.
  A deleted `defaultPreset` resets to `DEFAULT_PRESET` ("default") and never to another surviving preset —
  picking one would make the next bare `wsc` launch something the user never chose — and `log.warn`s about
  it only when that reset default names nothing *and* other presets remain (a remaining preset literally
  called `default` needs no warning, and an emptied project is simply unconfigured, not broken). Deleting
  a preset called `default` that was itself the default hits the same two branches. `deletePreset()` in
  `src/presets/store.js` follows the same `Object.prototype` house rule as every other preset write: lookups
  go through `hasPreset()`, and the surviving preset map is rebuilt with `Object.fromEntries` rather than a
  spread-then-`delete`, so a preset named `constructor` or `__proto__` deletes cleanly instead of touching
  the prototype.
- **Terminal commands are reconstructed from the IDE's naming convention**, because
  `get_run_configurations` reports only `name` and `description`. WebStorm names an npm configuration after
  its script, prefixed with the package.json directory when it is not the project root (`client > bundle:build`
  vs plain `web`), so `splitNpmConfigName()` cuts at the *last* `" > "` and `buildTerminalCommand()` emits
  `cd <dir> && npm run <script>`. Anything that is not an npm configuration is refused
  (`UnsupportedLaunchError`) rather than guessed at — a "Node.js" configuration's entry file simply is not
  knowable from here.
- `src/mcp/execute.js` — the two launching tools plus `runExecutionPlan()`. Kept out of `exec/` because *which*
  tool an entry needs is policy while the tool names and argument shapes are protocol.
  `waitForExit: false` and `reuseExistingTerminalWindow: false` are not tuning knobs, they are the feature:
  the first is what lets several tabs run at once instead of serialising on the first dev server, the second
  is what gives one new Terminal tab per call.
- **`execute_terminal_command`'s own `timeout` argument is ignored** on WebStorm 2026.2.1 — measured:
  `sleep 8` with `timeout: 1500` returned after 8017ms, `sleep 1` after 1014ms. The call just waits for the
  command to exit. So the bound is applied client-side (`McpCall.timeoutMs` → `client.callTool(..., {timeoutMs})`)
  and a request timeout on a *bounded* call is counted as **started**, not failed — verified that abandoning
  the call does not kill the command (a file touched six seconds after a two-second bound still appeared).
  An unbounded call that times out is still a real failure.
- **Two more classes joined `KNOWN_ERRORS` in phase 10, both found by asking "what does this print?".**
  `McpConnectError` (`src/mcp/client.js`) wraps every failure of `connectMcp`: `discoverPort()` only probes
  `/sse`, and the session is opened over a *second* request, so the IDE can quit in between and the
  best-effort range scan can hand back a port belonging to something else — and the SDK's own
  `StreamableHTTPError` has `name === 'Error'`, so the user got a V8 stack trace through `node_modules`
  (reproduced against a plain HTTP server that answers `/sse` with `text/event-stream` and 404s `/stream`).
  `RunConfigPayloadError` (`src/resolve.js`) is what `normalizeRunConfigs()` throws instead of a bare
  `TypeError`: a bare one reads as a bug inside wsc and was rethrown the same way. It stays a `TypeError`
  subclass so nothing that caught one stops working, and its message points at `npm run mcp:probe`, since
  the plan's own risk table calls a change in the IDE's tool signatures the likeliest cause.
- **`McpError` (the SDK's own class) is in `KNOWN_ERRORS`.** Before phase 6 the only MCP call was
  `get_run_configurations`, so a transport/protocol failure was near-unreachable; a launch makes it routine
  (`runExecutionPlan` deliberately rethrows it), and left out it dumped a V8 stack trace through
  `node_modules` at the user — the same bite as the earlier missing-error-class finding. `executePlan()`
  additionally translates it into a `WscError` that says the already-open tabs are unaffected; the
  `KNOWN_ERRORS` entry is the backstop for the call sites that never reach that translation (connect,
  `get_run_configurations`), and has its own test because the translation would otherwise shadow it.
- **A terminal command that fails is still a *successful* tool call.** `execute_terminal_command` answers
  `{command_exit_code, command_output}`, so `launchFailureReason()` has to read the exit code; without it a
  `npm run` that died with `command not found` is reported as a launched tab. (On this machine the IDE's
  terminal has no `npm` on `PATH` — nvm is not initialised for WebStorm's environment — even though
  `execute_run_configuration` works fine, since that uses the IDE's configured Node interpreter. So
  `--target=terminal` degrades here for reasons outside the CLI.)
- **Launching is not atomic, unlike plan building.** By the time the first call goes out the user has already
  been told what will start, so one rejected launch must not silently cancel the rest: every entry is
  attempted, each failure is reported as it happens, and `executePlan()` prints `started N of M … failed: …`
  and exits 1. Calls are issued **sequentially** so tabs appear in the order the CLI just printed; that costs
  nothing on the run-window path (`waitForExit: false` returns in ~70ms) and one `TERMINAL_TIMEOUT_MS` per
  terminal tab. Only a failure that is *not* about one configuration (transport, protocol) aborts the run —
  the rest would fail identically, each after the full call timeout — and even then it names what already
  started first. `AmbiguousProjectError` deliberately falls into that bucket, which is why the runner matches
  `err.name === 'McpToolError'` rather than `instanceof` (the subclass would otherwise be retried per entry).
- `src/presets/store.js` — reads/writes `.idea/webstorm-commands.json`. Every write goes through
  `writeFileAtomic()`: temp file **in the same directory** (`rename` is only atomic within a filesystem) →
  `fsync` → `rename` → `fsync` on the directory. Parsing never falls back to defaults on bad input — it
  throws `PresetConfigError` naming the file, because silently resetting a hand-edited config destroys the
  user's work. Unknown top-level keys and unknown keys inside preset entries are round-tripped untouched,
  and `serializeConfig()` has a fixed key order so rewriting an unchanged config is a no-op diff.
  Schema upgrades go in the `MIGRATIONS` registry (keyed by the version migrated *from*); `migrateConfig()`
  chains them up to `SCHEMA_VERSION`. Order matters: migrations run on loosely-shaped data **before** strict
  entry validation, and a missing `version` key means 0, not "current". Reading a legacy file migrates in
  memory only — the upgrade reaches disk on the next explicit write, never as a side effect of a read.
- **`src/fallback/` — the no-IDE path (phase 8).** Same pipeline as the main one, both ends swapped: the
  catalogue comes from `.idea` on disk instead of `get_run_configurations`, and the tabs from an OS terminal
  emulator instead of WebStorm. Everything in between (`parseRequests`, `buildLaunchPlan`, `resolveName`, the
  inspector-port assignment, `shellQuote`/`debugEnvPrefix`) is literally the same code, so a name that is
  ambiguous on one path is ambiguous on the other.
- `src/fallback/ideaRunConfigs.js` — **`get_run_configurations` read off disk**, and, since phase 9, the
  source `--list` falls back to as well (`DISK_SOURCE` is the one spelling of "where this came from", shared
  by both messages): `.idea/workspace.xml`
  (`<component name="RunManager">`) plus `.idea/runConfigurations/*.xml`. For demo-app that is the *same
  13 names* the live IDE reports, and a test pins exactly that against both fixtures. `package.json` cannot
  substitute for it: the configuration called `web` runs the script `dev` in `web/package.json`, and
  there is no `web` script anywhere in the project. The XML also carries what MCP does not — package.json
  path, npm command, script, arguments, envs, pinned interpreter — so `buildFallbackCommand()` reconstructs
  `cd web && npm run dev` exactly instead of inferring it from the shape of the name (which is all
  `buildTerminalCommand()` in planBuilder can do; see the warning below). The trade-off is staleness: a
  configuration the IDE has not written out yet is unknown here, which the error message says out loud. The
  parse is deliberately regex-based — a handful of fixed elements written by one program, every value
  attribute-encoded, and a dependency for that would be out of proportion.
- **A `.idea` file is untrusted input.** `.idea/runConfigurations/*.xml` is normally checked into the
  repository, so cloning one and running `wsc --fallback=terminal` must not run whatever it says. Every
  field `buildFallbackCommand()` interpolates is therefore quoted (`dir`, the interpreter directory, env
  *values*, the npm script, the entry file) — including the npm subcommand, which is one word out of the
  IDE's own dropdown, so `npm 'install'` costs nothing and a hand-edited `install; …` stops being two
  commands. An env var *name* is the one field that cannot be quoted (`'A B'=x` is a command called `A B=x`,
  not an assignment), so it is validated against `ENV_NAME` and refused otherwise. `config.args` is the
  single deliberate exception: it is shell text the user typed into the IDE, and quoting it would turn
  `--port 3000` into one word. The regression tests run the built line through a real `/bin/sh` with `npm`
  stubbed out and assert that no second process ran, each with a control proving the unquoted form really
  does run one.
- **"Project node" is resolved from `.nvmrc`, in `readIdeaRunConfigs()` (`src/fallback/projectNode.js`).** A Node.js
  configuration normally pins no interpreter (`path-to-node` is absent) and many npm ones store `project`, which
  the IDE resolves to `.nvmrc` → `~/.nvm/versions/node/vX/bin/node`. wsc used to ignore that and leave PATH alone, so
  `wsc int:debug` ran under the shell's default node (v20 here) while the IDE runs the project on v14.21.3 — found
  by running the built command and reading the inspector's `/json/version`. Only literal versions are resolved
  (`14`, `14.21`, `v14.21.3`; the highest installed match, compared numerically); `lts/*` and named aliases are
  nvm's own registry and are left alone, as is a version that is not installed — both degrade to the shell's PATH
  exactly as before. A configuration's own pinned interpreter always wins. The parser stays pure: it still leaves
  `project` unset, and the disk read happens once in `readIdeaRunConfigs()`, so the IDE path (`ideaCommandResolver`)
  and the no-IDE path get it together. `node-parameters` (Node.js configurations) is read too and placed between
  `node` and the file, since after the file it would be the program's own argument.
- **Every adapter prints the exit line, macOS included.** `reportExit()` is split out of `keepOpen()`
  because Terminal.app needs one half and not the other: `do script` already leaves an interactive shell
  behind, so there is no `exec bash` tail, but skipping the whole helper also dropped
  `[wsc] <name> exited with status <code>` — a crash then looked different there than on every other
  platform, which reads as a bug rather than as a design.
- `src/fallback/terminalTabs.js` — emulator detection + spawn, one small data object per emulator
  (`TerminalAdapter`) so adding a fifth means adding one object and one test. Detection: platform gate →
  `DISPLAY`/`WAYLAND_DISPLAY` gate → every declared binary on PATH (the emulator *and* the `bash` it drives).
  The PATH lookup is injectable, which is what makes the whole file testable on a machine that has one
  emulator installed. **gnome-terminal has to use the deprecated `-e`**, not the plan's `--` form: `--` means
  "the rest of the argv is the command", greedily, so of `--tab … -- bash -c A --tab … -- bash -c B` only A
  ever runs (verified on 3.52 — the second tab's marker file never appeared). `-e` takes one string, can be
  repeated, and gives real tabs in one window; the payload is the only place a string is re-parsed, so it is
  the only place `shellQuote()` is applied. Everything else is argv, so a name like
  `api > repro:stale-job:debug` cannot break out of anything. Tabs are spawned detached with stdio
  ignored — they must outlive `wsc` — and a settle window catches an emulator that exits non-zero at once
  (gnome-terminal is a client that returns 0 immediately, so "spawned" is not "opened").
- `src/fallback/singleTabPool.js` — last resort when no emulator exists: every command as a child of `wsc`,
  output tagged with `log.tagged()` (the palette in `src/log.js`, no second colour system) and line-buffered
  so two servers writing at once cannot tear each other's lines. **Ctrl-C must signal the process *group*,
  not the child**: `bash -c "npm run dev"` becomes bash → npm → sh → the server, and killing only the child
  leaves the server holding the output pipe, so `'close'` never fires and the pool hangs forever with the
  processes it was asked to stop still running. Found exactly that way, live. Hence `detached: true` per
  child (its own group) and `process.kill(-pid, …)`, with a fallback to `child.kill()` for Windows and for a
  child that is already gone.
- `src/fallback/terminalFallback.js` — the orchestration, and **the second half of the `--dry-run` guard**.
  The fallback branch in `src/cli.js` returns *before* the `--dry-run` check further down, so `wsc --dry-run
  --fallback=terminal` would open real windows without the guard inside this file. `dryRun` therefore travels
  in the hand-over context, and two tests (one per half) pin it.
- `src/cli.js` hands the fallback the **raw positional tokens**, not parsed requests: splitting
  `name:debug` needs the list of real names, and the fallback has one a moment later (off disk), so it does
  the split itself with `isKnownName`. Splitting in `cli.js` would throw that away.
- **`src/exec/ideaCommands.js` — the phase-6 caveat, closed in phase 10.** `buildTerminalCommand()` in
  `planBuilder.js` rebuilds an npm command from the *name* (`web` → `npm run web`), because MCP
  reports nothing else; measured against the anonymised demo-app `.idea/` fixtures, that guess gets **2 of 13**
  configurations right, gets 10 *wrong* (`web` is really `cd web && npm run dev`, and there is no
  root `web` script at all; `client > bundle:build` really lives in `gateway/addon/client`) and
  cannot express the 13th. So `--target=terminal` and every `:debug` could open a tab that died on
  "Missing script". The fix keeps **MCP as the catalogue** — resolution, ambiguity and the preset are
  untouched — and reads only the *command* out of `.idea/`, through the very `buildFallbackCommand()` the
  no-IDE path already uses. `ideaCommandResolver()` is injected into `buildExecutionPlan()` as `commandFor`
  rather than imported by it, which is what keeps `planBuilder.js` pure and keeps `exec/` from forming an
  import cycle with `fallback/`. **The run-window path is deliberately unchanged**: there
  `execute_run_configuration` takes the name and the IDE owns the rest, and `needsTerminalCommands()`
  means a plain run-window plan never even reads `.idea/`.
- **A name `.idea/` does not have degrades to the old guess, out loud — it is not refused.** WebStorm writes
  run configurations out on its own schedule, so one created minutes ago is genuinely missing. Refusing was
  considered and rejected: `:debug` has no other route (there is no debug parameter in the MCP API), so a
  refusal would make a brand-new configuration undebuggable, and the guess is exactly what shipped in
  phases 6–9 — it is not made worse by being labelled. `guessedCommands()` collects the affected names and
  `guessedCommandNote()` prints them once, and `--dry-run` shows the exact command before anything starts.
  The lookup is a `Map`, per the house rule, and the test that discriminates is a name that is **absent**
  (`toString`), not one that is present: `{}["constructor"]` is shadowed by an own property and looks
  correct, while `{}["toString"]` hands `Object.prototype.toString` to the command builder.
- **A refusal from `.idea/` on the MCP path names the flag, not the MCP Server.** `buildFallbackCommand()`
  took an `opts.advice` parameter in phase 10 for exactly this: its own default ("Start the MCP Server and
  re-run") is the right answer only when the IDE is unreachable, and would name the one thing already true
  when it is answering. `terminalEscapeHint(mode)` in `planBuilder.js` is the single source of the other
  two lines, shared with `UnsupportedLaunchError`.
- **`src/completion/` — Tab completion (zsh, bash), and why it has its own entry point.** The shell wrapper
  (`wsc --completion <shell>` prints it) hands the line up to the cursor to `wsc __complete <shell> <line>`;
  `bin/wsc.js` routes that to `src/completion/run.js` **without loading `src/cli.js`**, because `cli.js`
  statically imports `@inquirer/prompts` and `wsc --version` costs 0.21 s against 0.05 s for bare `node` —
  a cost paid on every keypress. Pinned by `test/completionBoundary.test.js`, which walks the *static* import
  graph from `run.js` and forbids `cli.js`, `src/ui/` and any package (`src/mcp/` is allowed: its SDK import
  is dynamic). That is why `FALLBACK_MODES` moved into `src/modes.js`. Names come from `.idea/`
  (`readIdeaRunConfigs`), **never MCP**: a Tab cannot wait for a connection, and a configuration the IDE has
  not saved yet is simply absent. Answer protocol: first line `values` | `dirs` | `none`, then one candidate
  per line. **Escaping is done in JS (`format.js`), not in the shell**: zsh gets raw names and `compadd`
  quotes them; bash gets ready `COMPREPLY` items, cut after the last *bare* `COMP_WORDBREAKS` character
  (`:`, `=`, `>` are word breaks in bash, and `api > repro:stale-job:debug` has all of them) and
  backslash-escaped. The wrapper passes the raw line, not `COMP_WORDS`, for the same reason. The tokenizer ends a
  command at a bare `;`, `|` or `&` (so `&&` and `||` too), so an earlier command in a list cannot leak its
  flags or its `--project` into this one. `compopt -o filenames` is used for the `dirs` directive **only**, never
  for names: readline appends `/` to a candidate that matches a directory in the working directory, and demo-app
  has both a configuration and a directory called `web`. A leading `~` in `--project` is expanded with
  `os.homedir()` (the shell has not expanded it yet); `~user` is not. A candidate containing a control character
  (`CONTROL_CHARACTERS`, the preset store's own definition) is dropped, not escaped. Every failure means
  "offer less": exit 0, empty stderr, `WSC_COMPLETE_DEBUG=1` prints why. `__complete` is a reserved word only
  as `argv[0]`. The zsh wrapper is tested with stubbed `compadd`/`_files`/`_wsc_line` (BUFFER and CURSOR
  exist only inside ZLE); the real Tab is checked by hand through a pty.
- `scripts/mcp-probe.js` — manual diagnostic script, deliberately **not** part of the CLI. Walks
  discover → connect → list tools → `get_run_configurations` against a real, running WebStorm instance and
  reports each step separately. Keep this working across IDE upgrades; it's the fastest way to see what a
  new WebStorm version actually returns.

## Testing conventions

- Every phase ships its own `test/*.test.js` next to the code, not just an end-of-project pass.
- `test/cli.integration.test.js` is the phase-9 file: one `describe` per row of the final flag table, driven
  through `runCli()` with a fake `McpClient`, pinning the **exact** `--dry-run` text and the exact exit
  codes without a live IDE. `test/cli.test.js` still owns each flag's edge cases; this one owns the table
  and the seams between rows.
- `README.md` contains only captured output. Every block in it was produced by running the command against
  this repository's own three npm configurations (`test`, `test:coverage`, `test:watch`) with the IDE up and
  the plugin installed (or with `--mcp-port 65001` for the unreachable-IDE examples) — re-capture rather than
  hand-edit when the wording changes. The preset the blocks use is printed in the README; to reproduce them,
  copy `.idea/workspace.xml` into a scratch directory's `.idea/`, put that preset beside it, and run from
  inside that directory (a folder under the open project resolves to it). The previous captures were made
  against a private project, which is why none of its names appear any more.
- `test-utils/` (not `test/`) holds shared fakes (`fake-server.js` — real ephemeral HTTP servers for port
  probing, `fake-session.js` — a fake MCP session, `capture.js` — stdout/stderr capture). It lives outside
  `test/` on purpose: Node's `--test` runner treats every `.js` file under `test/` as a test file, so helpers
  in there would run as phantom always-passing tests.
- `test/presets.test.js` includes a real `SIGKILL` durability test: a child process writes the config in a
  tight loop and is killed mid-write, five times; the file must always still parse. The same loop written
  with a plain `fs.writeFile` corrupts the config in ~3 of 5 attempts, so the test genuinely discriminates.
- `test/ideaCommands.test.js` is the phase-10 caveat file, and it compares the two command builders against
  each other over the *whole* fixture rather than one example: the "2 of 13 agree" assertion is the finding
  itself, and it is what should move if a change ever makes the name-shaped guess correct again.
- `test/client.test.js` opens real sockets for `connectMcp` (`startServer`/`startSilentServer` from
  `test-utils/fake-server.js`): a probe-passing, handshake-refusing server and a socket that accepts and
  never answers are the two ways an MCP session fails in practice, and neither can be faked convincingly.
- `test/planBuilder.test.js` and `test/execute.test.js` never touch a real IDE: the plan builder runs against
  the phase-2 fixture and the runner against a mock client (plus `fakeSession` from `test-utils/`, so the
  `isError: true` unwrapping path is exercised end to end).
- `test/inspectorPorts.test.js` and the busy-port cases in `test/cli.test.js` use `occupyPort()` from
  `test-utils/fake-server.js` — a real listener on a real ephemeral port, because the only authority on
  "already in use" is the operating system. A port handed back by the OS and immediately closed is the
  known-free control case.
- `test-utils/fake-child.js` — `fakeSpawn()`/`fakeSignals()`: the phase-8 tests never spawn anything real.
  That is not only speed — it lets a Linux machine assert the exact `wt` and `osascript` command lines, and
  keeps a passing suite from leaving a dozen terminal windows open on the desktop.
- `test/fixtures/idea-workspace.xml` and `test/fixtures/idea-shared-node.xml` are an anonymised demo-app
  `.idea` (its names were rewritten; the structure was kept) (29 `<configuration>` elements for 12 distinct configurations — workspace.xml repeats them,
  hence the first-wins deduplication). `tmpIdeaProject()` in `test-utils/tmp-dir.js` builds a throwaway
  project from them.
- `test/fixtures/run-configurations.json` is a `get_run_configurations` payload (13 configurations) in the shape
  `scripts/mcp-probe.js --save-fixture` records, anonymised: names are demo-app's, structure is a real project's. Later phases
  (resolver, presets, execution) should reuse this fixture instead of requiring a live IDE.
- Code that is hard to unit-test directly (a live IDE, interactive `@inquirer/prompts` UI, real terminal
  `spawn`) is split into pure logic (tested) and a thin side-effecting wrapper (checked manually against the
  plan's per-phase checklist).
- An unreachable MCP Server is simulated with `--mcp-port <dead port>`; "the IDE came back" is a TCP proxy on
  that dead port forwarding to the real one, started mid-run. Interactive screens are driven through a real
  pty — `script -qec '<cmd>' /dev/null` with paced writes to stdin — which is how both the `--configure` and
  phase-7 prompts were checked by hand.

## Notes for future phases

- Both runtime dependencies are installed: `@modelcontextprotocol/sdk` and `@inquirer/prompts` (`^8`).
  `engines.node` is `>=22` — Node 18 and 20 were end-of-life before the first public release.
- Beware `@` inside a JSDoc `@param` description: `defaults to @inquirer/prompts` is parsed as a new JSDoc
  tag and silently truncates the list of nested `opts.*` params (it cost a round of confusing TS8032 errors
  in `src/ui/configure.js`). `node:util.parseArgs` and `node:test` are used instead of
  `commander`/`yargs`/a third-party test runner — see "Довідник · Залежності" in the plan for the reasoning.
