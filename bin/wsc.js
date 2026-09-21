#!/usr/bin/env node
// `wsc __complete …` is what the shell's Tab handler runs, on every keypress. It gets its
// own entry so it never loads src/cli.js, which pulls in the interactive prompts and costs
// several times what a completion can afford (test/completionBoundary.test.js pins this).
// Everything else is `runCli`, as before; both are imported only on the branch that needs them.
const argv = process.argv.slice(2);

const code =
    argv[0] === '__complete'
        ? await (await import('../src/completion/run.js')).completeCommand(argv.slice(1))
        : await (await import('../src/cli.js')).runCli(argv);

process.exit(code);
