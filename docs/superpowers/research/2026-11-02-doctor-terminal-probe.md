# Doctor terminal probe feasibility

Started: 2026-11-02; Linux follow-up completed: 2026-11-03.
**Linux feasibility: confirmed within the measured scope. Full cross-platform
Task 1 gate: not closed.** This is an experiment record, not a production adapter.

Linux follow-up on 2026-11-03 is recorded below. Windows acceptance is explicitly
deferred by the user; it is not silently treated as passed.

## Historical review disposition (first, rejected spike)

The reviewed spike has been **retired**, not promoted into a production adapter.
Both experimental Kotlin implementations and the MCP registration were removed
from the plugin. Non-compilable evidence copies are retained outside the checkout
under `/tmp/opencode/wsc-spike/rejected/*.kt.txt`. The sandbox was stopped.
There is no executable replacement tool in this change.

This removal addresses the code findings without preserving a second unsafe
implementation: no arbitrary-command diagnostic endpoint, EDT process startup,
unbounded capture, raw startup exceptions, unreliable widget framing, or
cancellation-unsafe cleanup remains in the added code. Existing production
terminal tools are unchanged. These findings remain design constraints for the
next **isolated** experiment, not claims that a replacement has been verified.

The original experiment violated Task 1 isolation: it used the main plugin source
set and the working repository as its project. A future experiment must use a
scratch-only build and a disposable project, explicitly set that project's working
directory, and compare against a fresh IDE-created terminal in the same project.
The plain-branch choice does not waive this requirement.

## Environment

Linux; installed WebStorm 2026.2.4, build 262.11879.105, bundled JBR 25.
The runIde sandbox uses separate IDE configuration and MCP port 64543.
The existing IDE used port 64542. Initial built-in `execute_terminal_command`
measurements targeted that IDE (scratch scripts probe3/4/5 target 64542).
The later direct-PTY spike measurements targeted sandbox port 64543. No
independent installation audit establishes the production IDE's historical
plugin state.
MCP must be explicitly enabled in the sandbox. Startup/first-run screens are
not evidence of MCP failure; the project eventually opened normally.

The sandbox inherits the environment of Gradle launched from the CLI, including
nvm on PATH. Therefore its successful Node lookup does **not** prove the same
lookup succeeds in the user's separately launched production IDE.

## Measured results

The built-in `execute_terminal_command` launches a process, not an interactive
shell: `cd ...` was treated as an executable name. With an explicit shell wrapper,
the observed streams were not TTYs, TERM was absent and Node was not found.
It cannot substitute for a real terminal probe.

A throwaway MCP tool running `LocalTerminalDirectRunner` directly successfully
created a PTY without opening a tab. Executed output included:

```text
TTY0_YES
TTY1_YES
/home/max-s26/.nvm/versions/node/v20.20.0/bin/node
v20.20.0
/home/max-s26/.nvm/versions/node/v20.20.0/bin/npm
10.8.2
```

Saved evidence: `/tmp/opencode/wsc-spike/lifecycle-results.json` contains a
success sample of 4670 ms including shell startup and cleanup. The shell honoured
the experimental explicit `exit 42`; this is **not** the exit status of Node/npm.
A 1000 ms timeout sample returned after 1723 ms with exit status 137. Its output
does not establish that the requested sleep started before timeout.

The JSON is a shortened, escape-filtered capture, not a byte-for-byte transcript;
the embedded `length=` refers to original capture length, not saved JSON length.
The table below preserves only the relevant observations, not startup output:

| Saved sample | Duration | Actual executed output | Shell exit |
| --- | ---: | --- | ---: |
| success | 4670 ms | TTY0_YES, TTY1_YES, Node v20.20.0, npm 10.8.2 | 42 |
| startup timeout | 1723 ms | no executed diagnostic result established | 137 |

A later 5816 ms running-command timeout and process scans were observed in chat,
but a corresponding standalone primary artifact was not retained. They are
**not acceptance evidence**. No reliable general child-process cleanup claim can
be made from the saved samples.

## Important correction: echo is not execution

Earlier probes returned only the typed command. Both implementations matched a
completion marker already present in the command's echoed input, then disposed
the shell before execution. This did **not** prove shell startup failed or that
the REWORKED widget cannot expose output.

The corrected experiment writes the completion marker using:

```sh
printf '%s%s\n' 'WSC_PTY_<nonce>' 'DONE'
```

The complete marker is absent from the input. Matching executed output then
produced the real TTY and version results above. A production parser still needs
unambiguous full framing, bounded storage, per-probe exit status, and protection
against ANSI/startup text. The experiment captures raw text only.

## API observations

Compile-tested against the installed IDE:

```text
LocalTerminalDirectRunner(Project)
ShellStartupOptions.Builder()
  .initialTermSize(TermSize(120, 32))
  .build()
LocalTerminalDirectRunner.configureStartupOptions(ShellStartupOptions)
LocalTerminalDirectRunner.createProcess(ShellStartupOptions): PtyProcess
```

Without `initialTermSize`, process creation throws `Initial term size must not
be null`. The configured shell was `/usr/bin/zsh -i`, with the IDE's shell
integration startup environment. The spike did not override PATH or NODE_OPTIONS.

**Compiler warning:** `createProcess(ShellStartupOptions)` is deprecated.
Earlier bytecode-only inspection missed this; it is not a stable-API guarantee.
The retired spike configured/created the process on EDT and read on a daemon
thread. This was **incorrect**, not merely unverified: the runtime log
`/tmp/opencode/wsc-spike/runide9.log:26–36` reports:

```text
SEVERE - This method is forbidden on EDT because it does not pump the event queue.
Switch to a BGT ...
at dev.wsc.ide.DoctorSpikeToolset$ptyProbe$proc$options$1.invokeSuspend(DoctorSpikeToolset.kt:61)
```

The complete log repeats the violation for process startup. No new implementation
may run these operations on EDT. A suitable public API and its threading contract
must be established and tested before production work.

`ShellProcessHolder.isPosix()` exists publicly, but it describes the process
platform. It is not by itself evidence that a selected Windows shell accepts
POSIX syntax. Windows shell detection is not resolved by this experiment.

The widget alternative exposes `TerminalWidget.sendCommandToExecute(String)`,
`getText()`, `isCommandRunning()` and `ttyConnector`. The observed runtime classes
were `TerminalWidgetBridge` and `BackendTtyConnector`. Its earlier echo-only
result must be retested with corrected framing before rejecting that route.

## Verification and remaining gate items

- `buildPlugin -PwebstormPath=/snap/webstorm/701`: passed after framing correction.
- `verifyPlugin -PwebstormPath=/snap/webstorm/701`: BUILD SUCCESSFUL, compatible
  against downloaded WebStorm 2026.2.3 (WS-262.10968.77). No internal API usages
  were reported. The complete plugin (existing code plus both spike routes)
  has one scheduled-for-removal API, two other deprecated API usages and eight
  experimental API usages. Specifically, the direct PTY route's `createProcess`
  is scheduled for removal; widget `getText` and `isCommandRunning` are
  experimental. This check targets 2026.2.3, not the 2026.2.4 runtime used for
  live measurements. Log: `/tmp/opencode/wsc-spike/verify-spike.log`.
- Not verified: failed shell startup; shell path containing spaces; disposable
  project isolation; client disconnect; coroutine cancellation; inherited
  `NODE_OPTIONS=--inspect-brk`; cleanup of arbitrary children.
- Windows PowerShell, Git Bash and WSL were not available and are **not passed**.
- No production tool contract or adapter is approved yet. Tasks 2/5/6 remain
  blocked until the gate is resolved or the scope is explicitly changed.

Throwaway sources and the temporary plugin registration are uncommitted and
have been removed from the build source set after review. Do not publish any old
experimental ZIP; rebuild from clean sources and inspect the nested JAR contents.

## Requirements for a replacement experiment

- Fixed commands only; no arbitrary-command MCP endpoint. Reject unsupported
  modes rather than advertising an unimplemented settings probe.
- Resource ownership from creation onward, cancellation rethrown, bounded cleanup
  in a non-cancellable context, and observed termination of shell, children,
  streams, reader and any owned tab. MCP disconnect is a separate live test.
- Bounded capture with explicit overflow; monotonic total deadline including
  startup/writes and a separate cleanup deadline. No caller-controlled unbounded
  timeout. A poll of `isCommandRunning() == false` is not readiness proof.
- Unambiguous executed framing and separate Node/npm exit statuses. Do not use
  the shell exit code as a probe result; only label EOF when a read observes EOF.
- Sanitize startup failures. Never return raw exceptions, startup options or
  environment to MCP clients; test with a harmless environment sentinel.
- Explicit disposable-project cwd matching `open_terminal_tab`, startup-noise
  and shell-path-with-spaces tests, and a comparison of both launch environments.
- Windows compatibility is shell-language detection, not only PTY OS detection.

## Review-fix verification

- Before source removal, a nested-JAR assertion failed on the distributable's
  `DoctorSpikeToolset` classes (expected regression reproduction).
- `clean buildPlugin verifyPlugin -PwebstormPath=/snap/webstorm/701`: passed.
  Verifier against 2026.2.3 reports only the existing production usages: one
  deprecated method and three experimental usages; no scheduled-for-removal
  usage from the retired spike remains. Log:
  `/tmp/opencode/wsc-spike/verify-without-spike.log`.
- Post-removal nested-JAR inspection: passed; no spike classes or registration
  in `build/distributions/wsc-companion-0.6.0.zip`. No spike Kotlin source remains.
- Reviewed sandbox PID 101828 is absent.
- CLI typecheck after removal: passed with Node 22.23.3.
- Full CLI test suite after removal: 1438 passed, 0 failed, 0 skipped under
  Node 22.23.3. Log: `/tmp/opencode/wsc-spike/review-fix-tests.log`.
- Independent follow-up review found no remaining Critical/Important code
  findings after retirement; minor provenance/status corrections were applied.

At retirement no research commit was made because the Linux investigation was
incomplete. The follow-up below supersedes that status. `docs/` is ignored;
the research-only commit uses `git add -f` for this exact path, not the docs tree.

## Isolated Linux follow-up (2026-11-03)

User authorized the Linux portion only and deferred Windows. New throwaway build:
`/tmp/opencode/wsc-doctor-linux`, with a separate Gradle sandbox and disposable
project `/tmp/opencode/wsc-doctor-linux/disposable project`. Main plugin sources
and registration are unchanged. No experiment tool accepts arbitrary shell text,
paths or environment from MCP. It refuses any other project path.

A harness restart erased `/tmp/opencode` during setup. Source and sanitized
results are now backed up in the gitignored plan workspace:
`.superpowers/sdd/2026-11-02-wsc-doctor/linux-spike-evidence/`. IDE activation and
configuration files are not copied into this evidence backup.

### Result transport and threading

The direct PTY route uses public `LocalTerminalDirectRunner(Project)`:

```text
ShellStartupOptions.Builder()
  .workingDirectory(project.basePath)
  .initialTermSize(TermSize(120, 32))
  .build()
runner.configureStartupOptions(options)
runner.createProcess(configuredOptions): PtyProcess
```

Configuration, process creation and stdin writing run on an owned daemon
background thread, never EDT. The overall deadline starts before acquisition.
An owner records the process before writes; a late acquisition after closure
destroys the process instead of publishing it to a cancelled caller.

Baseline does not override PATH or NODE_OPTIONS. The configured executable was
`/usr/bin/zsh`; POSIX payload is sent only for the Linux experiment's recognized
POSIX shells or its own known POSIX fixtures. This says nothing about Windows.

The same fixed payload runs both in the direct PTY and in a fresh reference
widget created through `createShellWidget(project.basePath, title, true, false)`.
Shell builtins write nonce-framed records to a private temporary result file:
`RS + nonce + US + field + US + value + newline`. The echo is never this file's
content. Java reads at most 65537 bytes, treats overflow as failure and ignores
incomplete/foreign-nonce records. PTY output is drained with a fixed 4096-byte
buffer, counted but not retained; more than 64 KiB triggers failure. Node/npm
path, version and exit status are separate fields. No Node/npm is needed for
the result channel itself.

**Experimental caveat:** version capture currently uses shell command
substitution; IDE capture memory is bounded, but this does not impose a memory
limit on a hostile executable masquerading as node/npm. Production must capture
version output with an independent bounded channel rather than copying this
throwaway payload unchanged.

### Cleanup and lessons measured during follow-up

The **entire** cleanup is enclosed in one outer `withContext(NonCancellable)`;
blocking cleanup within it runs on `Dispatchers.IO`, snapshots owned
descendants, terminates children then shell, closes streams and joins its reader.
Use `ProcessHandle.of(pty.pid())`, not `pty.toHandle()`; the first attempt failed
cleanup using the latter. Only the newly created shell's descendants are touched.

For the reference widget, close its identified shell **before** removing the
owned content. Removing a live terminal content first raised a modal confirmation
and exceeded the client deadline. A thread dump confirmed that path. The corrected
scenario terminates its shell off EDT, then disposes/removes only that widget's
content on EDT; tab count returns to its previous value without a prompt.

The actual local coroutine-cancellation test initially failed: the shell was
terminated, but returning between separate non-cancellable dispatcher blocks
restored a cancelled parent and skipped later file/audit cleanup. The outer
shield above fixed this. The repeated live test returned `cancelled=true`,
cleanup 38 ms, no reader or owned child left, and unchanged tab count. Its former
private directory was recorded and removed explicitly after checking the shell
was gone. Evidence: `cancel-local-red.log`, `cancel-local-red-leftover.json` and
`cancel-local-fixed.log` in the plan's evidence directory.

Do not run `test -t 1` inside command substitution: it then tests the substitution
pipe. The corrected test executes directly in the interactive shell and only
writes its already-computed result to the private file.

### Final measured Linux matrix

Times below are server-reported totals including cleanup; sources are complete
structured result JSON, not shortened raw terminal screen captures.

| Scenario | Result | Total ms | Cleanup ms |
| --- | --- | ---: | ---: |
| Configured zsh PTY | Node v20.20.0 / npm 10.8.2, exits 0 | 3509 | 36 |
| Fresh IDE terminal tab | Same cwd, TTY, paths, versions and exits | 3757 | 47 |
| Missing Node/npm fixture | Both exits 127, no fabricated versions | 112 | 28 |
| Invalid executable / private env sentinel | Sanitized shell-start-failed | 26 | 0 |
| Slow startup (2 seconds) | Completed | 2178 | 26 |
| Shell executable path containing spaces | Completed | 180 | 25 |
| Startup noise | Completed, no echo false positive | 155 | 27 |
| Excessive startup output (100000 bytes) | output-overflow | 115 | 38 |
| Inherited inspector NODE_OPTIONS fixture | Timeout at npm; Node result retained | 10049 | 47 |
| Running sleep timeout | Timeout | 10039 | 37 |
| Client request cancellation | Request rejected; server deadline cleanup | 10048 | 37 |
| Client transport disconnect | Request rejected; server deadline cleanup | 10047 | 36 |
| Actual child-coroutine cancellation | cancelled=true, owned sleep removed | 4537 | 36 |

All these successful cleanup assertions checked no owned shell/observed children
were running afterward, reader not alive, and unchanged tab counts. They establish
these Linux cases, not cleanup of an arbitrary malicious/forking process tree.
No private session directory remained after the final run. The scratch IDE was
stopped afterward. The reference test started with zero existing terminal tabs;
an already-open user's tab and its contents were not separately acceptance-tested.

**MCP limitation:** client AbortSignal sends cancellation, but the measured IDE
does not deliver it as coroutine cancellation to this tool (`cancelled=false`).
Disconnect likewise leaves the tool running until its own deadline. Therefore
the independent server deadline is essential; immediate cleanup on transport
cancellation is not established. The separate actual coroutine-cancellation test
above verifies non-cancellable cleanup; do not conflate these two mechanisms.

Parser tests cover echo rejection, split/foreign-nonce records, overflow and
incomplete final frames: **4 passed**. The final complete matrix passed all
**11 scenarios**, plus both separate client lifecycle checks. Final scratch
`test buildPlugin verifyPlugin` completed successfully after the cancellation fix.
Verifier against WS-262.10968.77 (2026.2.3) reported compatibility and no internal
API findings; the live runtime was WS-262.11879.105 (2026.2.4). Scheduled-for-removal
`createProcess` remains a version-pinning/upgrade risk, not a stable future API.

Independent read-only review found no Critical/Important defect invalidating the
Linux measurements. It explicitly did not approve this scratch code as a
production implementation. No production adapter is implemented.

### Reproduction and preserved evidence

Source, scripts and sanitized results are in the plan's gitignored
`linux-spike-evidence/` directory. The original raw `/tmp` artifacts from the first
day were lost in the harness restart; historical observations above are not
freshly reverified evidence. The final Linux acceptance logs are complete JSON
records, backed up outside `/tmp` before stopping the sandbox.

From the isolated project, with bundled JBR and Node 22:

```sh
JAVA_HOME=/snap/webstorm/701/jbr ./gradlew test buildPlugin verifyPlugin -PwebstormPath=/snap/webstorm/701
JAVA_HOME=/snap/webstorm/701/jbr ./gradlew runIde -PwebstormPath=/snap/webstorm/701 --args="'/tmp/opencode/wsc-doctor-linux/disposable project'"
node run-matrix.mjs baseline reference missing failed-startup slow spaces noise overflow inspect timeout cancel-local
node cancel-disconnect.mjs cancel
node cancel-disconnect.mjs disconnect
```

The runner discovers only ports belonging to the scratch IDE PID, not the main
IDE. No real project command, npm script, install or nvm repair is run. Missing,
startup-noise and inspector scenarios deliberately alter their **test fixture**
environment; baseline and reference retain the IDE's configured environment.

SHA-256 of preserved final logs:

```text
4e5c6e6b7b8da2416befa98ef6177f5962747b09c6c9e8a4d926ecfc58a7ef5d  acceptance-matrix.log
7fdd80b161e3e0210e32175cf1c76120421b86459163b9f31a497c63279fc631  acceptance-cancel.log
5c9e0bdc299a42a7b27e0cd1eb7a31ed211579c702cf041ff84f98afec2d4102  acceptance-disconnect.log
ab6d7b2eefa5efee3a0cdc98f34f9055576c0dc2e5de69ae237baf0b3f305e1f  acceptance-build.log
```

### Decision and remaining scope

Public IDE APIs provide a workable Linux PTY/result/cleanup route for the tested
configurations. This completes the requested Linux investigation, **not** the
whole cross-platform gate or a production feature. Windows is deferred by the
user and remains unverified. Tasks 2/5/6 do not automatically proceed.

A production adapter must not copy the throwaway code unchanged: cap version
capture outside shell command substitution, make cleanup failure a first-class
result, preserve an independent server deadline despite unsupported host
transport cancellation, review late-acquisition/blocking-API failure paths, and
pin/reverify the deprecated public API. Measured cleanup times are not a hard
guarantee for a blocked EDT, unresponsive platform API or adversarial process tree.
