const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

/** Palette used to give each run configuration a stable prefix color (phase 8). */
const PREFIX_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[91m'];

/**
 * Decide whether ANSI colors may be written to a stream.
 * Order matters: NO_COLOR wins over FORCE_COLOR is a deliberate choice
 * (an explicit opt-out should never be overridden by an inherited env var).
 *
 * @param {NodeJS.WriteStream} stream
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function supportsColor(stream, env = process.env) {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
    if (env.TERM === 'dumb') return false;
    return Boolean(stream.isTTY);
}

/**
 * @param {string} name
 * @returns {string} ANSI color code, stable for a given name across runs
 */
export function prefixColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return PREFIX_COLORS[hash % PREFIX_COLORS.length];
}

/**
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.stdout]
 * @param {NodeJS.WriteStream} [opts.stderr]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {keyof typeof LEVELS} [opts.level]
 */
export function createLogger(opts = {}) {
    const stdout = opts.stdout ?? process.stdout;
    const stderr = opts.stderr ?? process.stderr;
    const env = opts.env ?? process.env;
    const levelName = opts.level ?? env.WSC_LOG_LEVEL ?? 'info';
    const threshold = LEVELS[levelName] ?? LEVELS.info;
    const color = supportsColor(stderr, env);

    const paint = (code, text) => (color ? `${code}${text}${ANSI.reset}` : text);

    const write = (level, stream, prefix, args) => {
        if (LEVELS[level] > threshold) return;
        stream.write(`${prefix}${args.join(' ')}\n`);
    };

    return {
        color,
        level: levelName,

        /** Diagnostics go to stderr so stdout stays a clean data channel for pipes. */
        error: (...a) => write('error', stderr, paint(ANSI.red, 'error: '), a),
        warn:  (...a) => write('warn',  stderr, paint(ANSI.yellow, 'warn: '), a),
        info:  (...a) => write('info',  stderr, '', a),
        debug: (...a) => write('debug', stderr, paint(ANSI.dim, 'debug: '), a),

        /** Program output (e.g. `--list` results) — the only thing written to stdout. */
        out: (...a) => stdout.write(`${a.join(' ')}\n`),

        /** Line prefixed with a run configuration name, used by the terminal fallback. */
        tagged: (name, line) => stderr.write(`${paint(prefixColor(name), `[${name}]`)} ${line}\n`),
    };
}

export const log = createLogger();