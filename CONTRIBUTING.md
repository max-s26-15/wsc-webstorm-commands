# Contributing

Thanks for looking. Issues and pull requests are welcome; for anything larger than a fix,
open an issue first so we can agree on the shape before you write it.

## Setup

You need Node.js 22 or newer and git.

```bash
git clone https://github.com/max-s26-15/wsc-webstorm-commands.git
cd wsc-webstorm-commands
npm ci
npm link
wsc --version
```

`npm link` puts a `wsc` command on your `PATH` that runs straight from this checkout, so your
edits take effect immediately. If it fails with a permissions error, your global npm prefix is not
writable: use a Node installed through [nvm](https://github.com/nvm-sh/nvm), or
`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`. `npm unlink -g
webstorm-commands` undoes it.

There is no build step: the CLI runs straight from source (plain ESM). Types are JSDoc, checked by
`tsc --noEmit`.

## Tests

```bash
npm test              # the whole suite (node --test)
npm run typecheck     # JSDoc types in bin/, src/, scripts/
node --test test/resolve.test.js                            # one file
node --test --test-name-pattern='dry-run' test/cli.test.js  # tests whose name matches
```

- Every change ships with its tests, next to the code in `test/`.
- Shared helpers and fakes go in `test-utils/`, never in `test/`: `node --test` runs every `.js`
  file under `test/` as a test file.
- A test that runs a command line through a real shell skips, with a reason, where that shell is
  missing — use the helpers in `test-utils/shells.js` rather than faking the shell.
- CI runs the suite on Linux, macOS and Windows with Node 22, 24 and 26. Paths in assertions are
  built with `path`, not written with `/`.

## README holds captured output only

Every block of output in `README.md` was produced by running the command, never typed by hand.
When wording changes, re-capture the block: copy `.idea/workspace.xml` into a scratch directory's
`.idea/`, put the preset printed in the README beside it, and run the commands from inside that
directory with WebStorm running and wsc Companion installed (a folder under an open project
resolves to it). Examples of an unreachable IDE use `--mcp-port 65001`.

## The IDE plugin (wsc Companion)

It lives in `ide-plugin/` (Kotlin, Gradle) and has its own [README](ide-plugin/README.md). You need a
JDK 21 — the one bundled with WebStorm works.

```bash
cd ide-plugin
./gradlew buildPlugin verifyPlugin                    # downloads WebStorm 2026.2.3, as CI does
JAVA_HOME=/snap/webstorm/current/jbr ./gradlew buildPlugin -PwebstormPath=/snap/webstorm/current
```

`-PwebstormPath` points at the folder that contains `product-info.json` (on macOS the `WebStorm.app`
bundle, with the runtime under `Contents/jbr/Contents/Home`; on Windows use `gradlew.bat`). Install
`build/distributions/wsc-companion-<version>.zip` with **Settings → Plugins → ⚙ → Install Plugin from
Disk…** and restart the IDE.

## Diagnosing the IDE

```bash
npm run mcp:probe -- /path/to/an/open/project
```

walks port discovery → handshake → tool list → `get_run_configurations` and reports each step. It is
the fastest way to see what a new WebStorm version actually returns; installed from npm the same
script is `wsc-mcp-probe`.

## Releasing (maintainers)

Two version lines, released independently by tag:

1. Bump `package.json` (CLI) or `ide-plugin/build.gradle.kts` (plugin).
2. Add its entry to `CHANGELOG.md` — `## [cli <version>]` or `## [plugin <version>]`. `npm test`
   fails until you do.
3. Merge to `main`, then push a tag on `main`: `v<version>` for the CLI, `plugin-v<version>` for the
   plugin. `release-cli.yml` / `plugin.yml` check the tag against the version, publish, and create the
   GitHub Release; a version that is already published is skipped, so a rerun is safe.
   A plugin version uploaded by hand (the first one) is only "published" once Marketplace has approved
   it — tag it after the approval, or the workflow uploads it a second time and fails.

## Pull requests

- One topic per pull request.
- CI must be green on all three operating systems.
- Say how you checked it — and if you checked it against a live WebStorm, which version.
