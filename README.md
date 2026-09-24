# wsc

Start a whole set of WebStorm run configurations with one command — each in its own
Run/Debug or Terminal tab, inside the IDE you already have open.

`wsc` talks to WebStorm's built-in **MCP Server**, so it launches the configurations the IDE
itself knows about (the same list the Run dropdown shows) using the IDE's own interpreter,
working directory and environment. Nothing is re-implemented and nothing is guessed at.

It comes in two parts:

- **`wsc`, a command-line tool** (Node.js). This is all you need to launch configurations.
- **A small WebStorm plugin** (`ide-plugin/`, optional but recommended). It adds two tools to the
  IDE's MCP Server. One makes `wsc name:debug` open a **real Debug tab**; without it, `:debug` falls
  back to a Terminal tab with a bare Node inspector that you attach to by hand — see
  [Debugging](#debugging-debug). The other makes every Terminal tab `wsc` opens a **real terminal**;
  without it, programs that draw their own screen show nothing there — see
  [A Terminal tab for one entry](#a-terminal-tab-for-one-entry-terminal).

Every block of output below is copied from a real run against this repository's own three npm
run configurations (`test`, `test:coverage`, `test:watch`), with WebStorm 2026.2.3 running and the
plugin installed — or with `--mcp-port 65001` (nothing listens there) for the "WebStorm is not
answering" examples. Paths such as `/home/max-s26/.nvm/…` are the author's; yours will differ.

## Requirements

- **Node.js ≥ 18** and **git**.
- **WebStorm**, running, with the project open. Its built-in MCP Server is what `wsc` talks to.
  Developed and tested on Linux with WebStorm 2026.2.3; the plugin needs 2026.2 or newer.
- To build the plugin: a **JDK**. The JetBrains Runtime that comes with WebStorm (its `jbr/`
  folder) is the one the plugin was built with, so use that. Gradle and everything else it needs
  are downloaded on the first build, so you also need network access.

## Installation

### 1. Get the code

Clone the repository — over HTTPS:

```bash
git clone https://github.com/max-s26-15/wsc-webstorm-commands.git
```

or over SSH:

```bash
git clone git@github.com:max-s26-15/wsc-webstorm-commands.git
```

then go into it:

```bash
cd webstorm-commands
```

### 2. Install the dependencies

```bash
npm install
```

### 3. Install the `wsc` command

```bash
npm link
wsc --version
```

`npm link` puts a `wsc` command on your `PATH` that runs straight from this checkout, so
`git pull` is all it takes to update it. If it fails with a permissions error, your global npm
prefix is not writable: use a Node installed through [nvm](https://github.com/nvm-sh/nvm)
(no `sudo` needed), or point npm at a directory you own with `npm config set prefix ~/.npm-global`
and add `~/.npm-global/bin` to `PATH`.

### 4. Turn on WebStorm's MCP Server

In WebStorm: **Settings → Tools → MCP Server** →

- tick **Enable MCP Server**, and
- tick **Run shell commands or run configurations without confirmation (Brave Mode)**. Without
  Brave Mode every launch waits for a click in the IDE.

The same screen shows the port. The IDE writes it nowhere on disk, so `wsc` finds it by scanning;
if that ever fails, pass it with `--mcp-port <n>` / `WSC_MCP_PORT`, or pin it with
**Help → Edit Custom VM Options →** `-Didea.mcp.server.force.port=<port>`.

At this point `wsc` already works — try `wsc --list` inside a project that is open in WebStorm.
The next two steps are for the Debug tab.

### 5. Build the IDE plugin

```bash
cd ide-plugin
JAVA_HOME=/snap/webstorm/current/jbr ./gradlew buildPlugin
cd ..
```

The plugin is built against the WebStorm you already have installed, so tell the build where it
is. The command above is for the **snap** install on Linux, which is what the author uses and the
build's default. For any other install, pass both the JDK and the IDE:

```bash
JAVA_HOME=<WebStorm folder>/jbr ./gradlew buildPlugin -PwebstormPath=<WebStorm folder>
```

where `<WebStorm folder>` is the folder that contains `product-info.json` (on macOS, the
`WebStorm.app` bundle; the runtime is then under `Contents/jbr/Contents/Home`). On Windows use
`gradlew.bat` and set `JAVA_HOME` the Windows way. I have only run the snap variant; the others
follow the same pattern.

The first build downloads Gradle and dependencies and takes a minute or two. It produces:

```
ide-plugin/build/distributions/wsc-ide-plugin-0.4.0.zip
```

(the version in the file name changes when the plugin does).

### 6. Install the plugin by hand, and restart the IDE

1. WebStorm → **Settings → Plugins → ⚙ (gear) → Install Plugin from Disk…**
2. Pick `ide-plugin/build/distributions/wsc-ide-plugin-<version>.zip` → **OK**.
3. **Restart the IDE.**

### 7. Check that it worked

Run the probe against a project that is open in WebStorm (it needs the project's path):

```
$ npm run mcp:probe -- /home/max-s26/max/new-projects/wsc-webstorm-commands
> webstorm-commands@1.0.0 mcp:probe
> node scripts/mcp-probe.js /home/max-s26/max/new-projects/wsc-webstorm-commands

✓ MCP Server on port 64542
✓ handshake complete (project: /home/max-s26/max/new-projects/wsc-webstorm-commands)
✓ 45 tools available
✓ get_run_configurations
✓ execute_run_configuration
✓ execute_terminal_command
✓ debug_run_configuration (optional, from the wsc IDE plugin)
✓ open_terminal_tab (optional, from the wsc IDE plugin)
✓ 5 run configurations
  mcp:probe      npm
  test           npm
  test:coverage  npm
  test:watch     npm
  typecheck      npm
```

The lines to look for are `✓ debug_run_configuration` and `✓ open_terminal_tab`. A `✗` there only
means the plugin is not installed, is older than 0.4.0, or the IDE was not restarted — `wsc` still
works: `:debug` takes the Terminal route, and Terminal tabs use the IDE's own terminal tool.

### Updating

```bash
git pull && npm install
```

Rebuild and reinstall the plugin (steps 5–6) after a `git pull` that touches `ide-plugin/`, **and
after every WebStorm update**: the MCP API the plugin extends is not a documented stable API, so
a new IDE build can need a fresh build of it. The plugin declares `since-build 262` (WebStorm 2026.2).

### Uninstalling

`npm unlink -g webstorm-commands` removes the command; **Settings → Plugins** removes the plugin.

## Tab completion

Add `source <(wsc --completion zsh)` to `~/.zshrc`, or `source <(wsc --completion bash)` to `~/.bashrc`;
`wsc` has to be on your `PATH` (`npm link`).

- `source <(wsc --completion zsh)` costs about 0.2 s in every new shell. Save the script once
  (`wsc --completion zsh > ~/.wsc-completion.zsh`) and `source` that file instead.
- bash 4 or newer is recommended. bash 3.2 (the macOS default) cannot `source <(…)`; use
  `source /dev/stdin <<<"$(wsc --completion bash)"`. It also has no `compopt`, so `--project`
  completes directories without escaping them.

```
$ wsc --completion zsh | head -8
#compdef wsc
# Tab completion for wsc. Add this to ~/.zshrc:
#   source <(wsc --completion zsh)

# The one place that reads ZLE's BUFFER and CURSOR, kept apart so the tests can replace it.
_wsc_line() { REPLY=${BUFFER[1,CURSOR]} }

_wsc() {
```

Names come from `.idea/`, never from the IDE, so a configuration you just created appears once WebStorm
has written it out. What the shell asks `wsc` for on Tab (the first line is the kind of answer, the rest
are the candidates):

```
$ wsc __complete zsh 'wsc --ta'
values
--target
$ wsc __complete zsh 'wsc api:'
values
api:run
api:debug
api:terminal
```

`WSC_COMPLETE_DEBUG=1` prints why a Tab offered less. `__complete` is reserved as the first argument.

## The flag table

| flag | what it does |
| --- | --- |
| `wsc` | launches the default preset |
| `wsc test:watch:debug test` | preset + extra names; the command line overrides the mode |
| `wsc test:watch:terminal` | that one configuration in an IDE Terminal tab, without a debugger (see [`:terminal`](#a-terminal-tab-for-one-entry-terminal)) |
| `-c`, `--configure` | interactive screen for choosing what the preset holds |
| `-l`, `--list` | print every run configuration the project has |
| `--preset <name> [<name> ...]` | use a different named preset, or launch several at once (`--preset a b`, or repeat the flag) |
| `--target=run-window\|terminal` | native Run/Debug tabs (default) or IDE Terminal tabs |
| `--dry-run` | print the exact calls without launching anything |
| `--fallback=retry\|terminal` | answer the "WebStorm is not answering" prompt in advance |
| `--completion <zsh\|bash>` | print a Tab-completion script for that shell (see [Tab completion](#tab-completion)) |
| `--project <path>` | project root (default: the nearest directory with `.idea/`) |
| `--mcp-port <n>` | MCP Server port (default: `WSC_MCP_PORT`, then a scan) |
| `--debug-port <n>` | first inspector port for Terminal-route `:debug` entries (default: 9229) |

## `wsc --list`

```
$ wsc --list
3 run configuration(s) reported by the IDE
test           npm
test:coverage  npm
test:watch     npm
```

The listing is the only thing on **stdout**; the summary line, and every warning, go to
stderr. So it pipes cleanly:

```
$ wsc --list | wc -l
3
```

`--list` prints the catalogue and stops. It launches nothing and reads no preset, so
`--target`, `--debug-port`, `--dry-run`, `--preset`, `--configure` and configuration names
are all refused rather than quietly ignored:

```
$ wsc --list test
error: --list takes no configuration names: it prints every one of them
```

(followed by the usage text; exit code 2, and the IDE is never contacted.)

## `wsc` — the default preset

A preset lives in `.idea/webstorm-commands.json` and is edited with `wsc -c`. The examples in
this README use this one:

```json
{
  "version": 1,
  "defaultPreset": "default",
  "presets": {
    "default": [
      { "name": "test", "mode": "run" },
      { "name": "test:coverage", "mode": "run" }
    ],
    "watch": [
      { "name": "test:watch", "mode": "debug" }
    ]
  }
}
```

```
$ wsc --dry-run
would launch 2 configuration(s) via run-window:
test           run    (preset)
test:coverage  run    (preset)
→ execute_run_configuration  test
→ execute_run_configuration  test:coverage
```

Drop `--dry-run` and the two Run tabs really open, in that order. `wsc -c` is the
interactive screen that writes the file: a checkbox list of everything the IDE reports, with
the current preset pre-checked, followed by a run/debug/terminal question for each newly checked
entry only, and a last step for adding a command of your own (see
[Your own commands](#your-own-commands-no-run-configuration)).

## `--preset <name>`

```
$ wsc --preset watch --dry-run
would launch 1 configuration(s) via run-window:
test:watch  debug  (preset)
→ debug_run_configuration  test:watch
```

## Debugging (`:debug`)

Names given on the command line are added to the preset; a name the preset already holds
keeps its position and only changes mode. A trailing `:debug` debugs that configuration:

```
$ wsc test:watch:debug --dry-run
would launch 3 configuration(s) via run-window:
test           run    (preset)
test:coverage  run    (preset)
test:watch     debug  (cli)
→ execute_run_configuration  test
→ execute_run_configuration  test:coverage
→ debug_run_configuration    test:watch
```

(`test:watch` is itself a configuration name with a colon in it; see [Names](#names) for how
`test:watch:debug` is told apart from it.)

**With the plugin installed** — the last line above — `:debug` is a call to the plugin's
`debug_run_configuration`. The IDE starts the configuration with its Debug executor, exactly as
its Debug button does: a real **Debug tab** opens and the IDE's own debugger attaches. Because it is
the IDE debugging, it also follows the child processes an npm script starts (`npm test`,
`npm run dev` → gulp / nodemon). No inspector port is involved. Since plugin 0.5.0 the session
starts with **breakpoints muted**: press *Mute Breakpoints* in the Debug tab to let it stop.

**Without the plugin**, the IDE's MCP API has no debug parameter, so `wsc` says so, opens a
**Terminal** tab instead, and rebuilds the command with `--inspect-brk`. It warns before it
launches — `debug mode goes through the IDE's Terminal window …` — and points here. Each such
entry gets its own inspector port, counting up from 9229, so two of them do not fight over one
port; point WebStorm's *Run → Attach to Node.js/Chrome* at the port `wsc` prints for the entry.

`--target=terminal` always takes that Terminal route, plugin or not — you named the terminal —
and `--debug-port` moves the range of ports:

```
$ wsc --debug-port 9400 --target=terminal --dry-run test:coverage:debug test:watch:debug
would launch 3 configuration(s) via terminal:
test           run    (preset)
test:coverage  debug  (cli)
test:watch     debug  (cli)
→ open_terminal_tab  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test
→ open_terminal_tab  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--inspect-brk=127.0.0.1:9400" npm run test:coverage
→ open_terminal_tab  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--inspect-brk=127.0.0.1:9401" npm run test:watch
```

## A Terminal tab for one entry (`:terminal`)

`run`, `debug` and `terminal` are the three modes an entry can have. `:terminal` starts that one
configuration as a command line in a new **IDE Terminal tab** — no debugger, no inspector port —
while the other entries of the same launch keep their own tab kind. It is what
[`--target=terminal`](#--targetterminal) does for the whole run, chosen per entry instead, so it can
also be kept in a preset:

```json
"default": [
  { "name": "test", "mode": "run" },
  { "name": "test:watch", "mode": "terminal" }
]
```

`wsc test:watch:terminal` asks for the same on the command line, and `wsc -c` offers it as the third
answer of the mode question. The header of a plan that mixes tab kinds reads
`via run-window + terminal`, and the `--dry-run` lines show `execute_terminal_command` for exactly
the entries that use the Terminal. The two knobs combine like this: `:terminal` on an entry keeps it
in the Terminal even under `--target=run-window`, and `--target=terminal` puts a `:debug` entry in the
Terminal too — as the same inspector-enabled command `:debug` uses without the plugin
(`NODE_OPTIONS=… --inspect-brk=…`, with an inspector port of its own), not as a Debug tab. `:terminal`
is the one that has no debugger at all.

Every Terminal tab — `:terminal`, `--target=terminal`, `:debug` without the plugin's Debug tool,
and [your own commands](#your-own-commands-no-run-configuration) — is a **new tab of its own, titled
with the name of the configuration** it runs (`test:watch`, not `wsc`).

**With the plugin (0.4.0 or newer)** it is a real terminal: the plugin's `open_terminal_tab` opens
the same kind of tab the Terminal window's **+** button does, runs your shell in it in the project
root, and types the command in, so colours, progress bars and full-screen programs (`ngrok`, `top`)
work and Ctrl-C stops the process. The `--dry-run` lines then read `→ open_terminal_tab`.
**Without the plugin** the tab comes from the IDE's own `execute_terminal_command`, which runs the
command on pipes instead of a terminal — measured: `[ -t 1 ]` is false and `TERM` is empty inside
it. The tab shows what the command prints, but a program that draws its own screen shows nothing
(ngrok prints only its warnings), and Ctrl-C there cannot reach it. `wsc` says so once per run.
On that route the
IDE's MCP tool has no parameter for a tab title, but it titles a tab after the MCP client that opened
it, so `wsc` opens one short-lived session per tab, called by the configuration's name. If such a
session cannot be opened the launch still happens, and `wsc` warns — once — that the tabs are titled `wsc`.

Without the IDE (`--fallback=terminal`) every tab is already an OS terminal, so `:terminal` there is
the same launch as `:run`. A preset that contains `"mode": "terminal"` is not readable by a `wsc`
built before this mode existed: it stops with an error naming the file rather than guessing.

## Your own commands (no run configuration)

A preset entry with a `commands` list needs no run configuration at all: `wsc` runs the commands in a
new IDE **Terminal tab titled with the entry's name**, the same tab kind `:terminal` opens.

```json
"default": [
  { "name": "test", "mode": "run" },
  { "name": "seed db", "mode": "terminal", "commands": ["npm i", "npm run seed"] }
]
```

`mode` is always `terminal` for such an entry, and may be left out. The commands are joined with `&&`,
so the series stops at the first one that fails, and the tab stays open with the output. Each command is
shell text, run as written — `cd server && npm run seed` is how a command picks its directory.

`wsc -c` adds one: after the checkbox list it asks `Add a custom command?`, then a name, then the
commands one at a time (an empty line ends the list; the first one is required). An existing custom
entry shows in the checkbox as `⌘ seed db — npm i && npm run seed`, and unchecking it removes it. A
name cannot be the name of a run configuration, or of another custom command in the same preset.

The commands are always printed on stderr before anything starts, under `custom commands from the
preset:` — as a warning, so that even `WSC_LOG_LEVEL=warn` leaves them visible. The preset file lives in `.idea/` and is usually committed, so a repository you have just
cloned could otherwise run shell text the first time you type `wsc`; this way you see what is about
to start. Without the IDE (`--fallback=terminal`) the same entry is a tab of the OS terminal, with the
same title:

```
$ wsc --dry-run --mcp-port 65001 --fallback=terminal
warn: WebStorm is not answering — launching without IDE tabs
would launch 2 configuration(s) without the IDE:
test     run       (preset)
seed db  terminal  (preset)
warn: custom commands from the preset:
  seed db: npm i && npm run seed
→ test     PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test
→ seed db  npm i && npm run seed
```

On the IDE path the same entry is one more `→ open_terminal_tab  npm i && npm run seed` line (`→ execute_terminal_command` without the plugin) in
the `--dry-run` output, in a tab of its own.

Limits worth knowing:

- A custom command cannot be started by name from the command line: `wsc "seed db"` is an
  `unknown run configuration` error. It runs as part of the preset that holds it.
- `--target` and `:debug` do not apply to it — there is no debugger and it always uses a Terminal tab.
- Each command is shell text joined with a literal ` && `, so a command that ends in a shell comment
  (`# …`) or a trailing backslash also swallows the next one.
- A preset made only of custom commands also works without the IDE when WebStorm has saved no run
  configurations to `.idea/` and you name no configurations on the command line, since it then needs
  no catalogue.
- A `wsc` built before this feature does not know such an entry and stops with an error rather than
  running anything: it reads the entry as a run configuration called `seed db` (`unknown run
  configuration`), or, if it is older than `:terminal` too, refuses the file by name.

## `--target=terminal`

`run-window` (the default) opens the IDE's native Run/Debug tabs. `terminal` runs the same
configurations as command lines in IDE Terminal tabs instead:

```
$ wsc --dry-run --target=terminal test:watch
would launch 3 configuration(s) via terminal:
test           run    (preset)
test:coverage  run    (preset)
test:watch     run    (cli)
→ open_terminal_tab  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test
→ open_terminal_tab  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test:coverage
→ open_terminal_tab  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test:watch
```

The command line is not guessed from the configuration's name: it is read out of the
definition WebStorm saved in `.idea/`, which is where the working directory, the real npm
script, the arguments, the environment and the pinned Node interpreter live. A configuration
that pins no interpreter runs under the project's Node — the version `.nvmrc` names, when nvm has
it installed — as the IDE would. A configuration the IDE has not written out yet (a brand-new one)
is the exception — that one falls back to a name-shaped guess, and `wsc` says so, naming it.

## `--fallback` — when WebStorm is not answering

With no terminal to ask in, `wsc` names the two flags that answer the question instead of
hanging on a prompt nobody can see:

```
$ wsc --list --mcp-port 65001
error: cannot reach WebStorm's MCP Server.
  Turn it on in Settings → Tools → MCP Server ("Enable MCP Server"), and enable
  "Run shell commands or run configurations without confirmation (Brave Mode)"
  there too — otherwise every launch waits for a click in the IDE.
  The same screen shows the port, as http://127.0.0.1:<port>/sse. The IDE writes it
  nowhere on disk, so pass it with --mcp-port or WSC_MCP_PORT; Help → Edit Custom VM
  Options → -Didea.mcp.server.force.port=<port> pins it across restarts.
  Not a terminal, so there is nobody to ask: re-run with --fallback=retry to
  poll for the IDE, or --fallback=terminal to launch without it.
```

In a terminal, the same situation draws a two-option prompt (try again / continue without
the IDE) — never a silent fallback. `--fallback=retry` polls for the IDE;
`--fallback=terminal` skips it entirely.

Without the IDE, both the catalogue and the tabs come from somewhere else: the
configurations are read out of `.idea/`, and each one gets an OS terminal tab
(gnome-terminal, konsole, Terminal.app, Windows Terminal) — or, if none of those exists,
one tagged, colour-coded stream in the current window.

```
$ wsc --list --mcp-port 65001 --fallback=terminal
warn: WebStorm is not answering — listing what it last saved to disk instead
warn: read from .idea/workspace.xml and .idea/runConfigurations/ — WebStorm's saved state, so a configuration
  it has not written out yet is missing from this list.
3 run configuration(s) saved by the IDE
test           npm
test:coverage  npm
test:watch     npm
```

That listing is the IDE's *saved* state, so it can lag behind a configuration created
seconds ago — which is why it says so, every time.

```
$ wsc --dry-run --mcp-port 65001 --fallback=terminal
warn: WebStorm is not answering — launching without IDE tabs
would launch 2 configuration(s) without the IDE:
test           run    (preset)
test:coverage  run    (preset)
→ test           PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test
→ test:coverage  PATH=/home/max-s26/.nvm/versions/node/v20.20.0/bin:"$PATH" npm run test:coverage
```

## Names

A name is resolved against what the IDE reports: exact match first, then
case-insensitive, then prefix. Each looser step has to land on exactly one configuration.

```
$ wsc tset --dry-run
error: unknown run configuration "tset"
Did you mean: test?
```

```
$ wsc tes --dry-run
error: "tes" matches several run configurations: test, test:coverage, test:watch
```

Resolution is atomic: a typo in the third name means none of the first two is launched.

A trailing `:run` / `:debug` / `:terminal` sets the mode — unless the whole token is itself a
configuration name. That is why `wsc test:watch` launches the `test:watch` configuration, while
`wsc test:watch:debug` debugs it: the token is checked against the names the IDE reported first,
and only then is the last `:debug` cut off. Use `name:debug:debug` to debug a configuration whose
name really does end in `:debug` (likewise `name:terminal:terminal` for `:terminal`).

## Exit codes

| code | meaning |
| --- | --- |
| 0 | everything asked for was started (or printed) |
| 1 | a runtime error: unknown name, unreachable IDE, a launch the IDE refused |
| 2 | a usage error: a bad flag, or flags that contradict each other |
| 130 | Ctrl-C at an interactive prompt; nothing was written or launched |

A partial launch exits 1 and names what did and did not start — launching is deliberately
not atomic, because by then the user has already been told what is coming.

## Troubleshooting

- **`✗ debug_run_configuration` in `mcp:probe`, or the "Terminal window" warning on `:debug`.**
  The plugin is not installed, or the IDE was not restarted after installing it, or a WebStorm
  update outdated it: rebuild and reinstall it (steps 5–6).
- **`Streamable HTTP session not found` right after restarting WebStorm.** The MCP Server is still
  settling. Wait a few seconds and run the command again.
- **`doesn't correspond to any open project`.** The MCP Server serves the projects open in the IDE
  right now. Open the project (or a folder inside it) in WebStorm, or pass `--project`.
- **A launch waits for a click in the IDE.** Brave Mode is off — see installation step 4.

## Known limitations

- **The plugin's tool can fail for a configuration, and `wsc` then reports it rather than falling
  back to the Terminal.** For example a configuration no debug runner accepts. It also gives the IDE
  10 seconds to confirm that the Debug tab exists, and reports a launch as failed if it does not.
- **The plugin is tied to the IDE build.** It extends an MCP API that JetBrains does not document as
  stable: rebuild it after a WebStorm update (see [Updating](#updating)).
- **A configuration WebStorm has not saved yet gets a guessed command line.**
  `--target=terminal`, `:terminal` and the Terminal route of `:debug` need a shell command, and
  `get_run_configurations` reports only a name and a type — so the real definition is read out of
  `.idea/` instead. A configuration created minutes ago may not be written there yet; that one
  falls back to rebuilding the command from its name (`test` → `npm run test`), which can be wrong.
  `wsc` names the configurations this happened to, and `--dry-run` shows the exact command
  before anything starts. Native Run/Debug tabs (the default, and `:debug` with the plugin) are
  never affected: the IDE launches those itself, from the name.
- **Only npm and Node.js configurations can be rebuilt as a command line.** Anything else
  is refused rather than guessed at, on both the `--target=terminal` (and `:terminal`) and the no-IDE paths.
- **Without the plugin, `:debug` on an npm configuration debugs npm, not your application.** The
  inspector is asked for through `NODE_OPTIONS`, which every `node` in the tree inherits — and the
  first one is npm's own CLI, so it takes the port and stops there. Wrappers that spawn a second
  node (npm, nodemon, gulp) therefore never reach your code. Install the plugin, or use a
  configuration that starts a debugger itself (`nodemon --inspect=…` as an npm script): run those
  with plain `wsc <name>` and attach to the port the script names.
- **The no-IDE catalogue can be stale**, since it is whatever WebStorm last saved to
  `.idea/`.

## Development

```
npm test              # node --test — the full unit suite
npm run test:watch
npm run test:coverage
npm run typecheck     # tsc --noEmit — the JSDoc types
npm run mcp:probe     # manual diagnostic against a live WebStorm instance
```

`CLAUDE.md` documents the architecture and the reasoning behind each design decision;
`ide-plugin/README.md` covers the plugin.
