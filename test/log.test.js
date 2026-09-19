import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, supportsColor, prefixColor } from '../src/log.js';
import { fakeStream } from '../test-utils/capture.js';

// Every test passes an explicit `env` so the machine's real environment
// (NO_COLOR, CI, TERM) can never make these assertions flaky.

test('NO_COLOR disables color even on a TTY', () => {
  assert.equal(supportsColor(fakeStream(true), { NO_COLOR: '1' }), false);
});

test('empty NO_COLOR is ignored, per the no-color.org spec', () => {
  assert.equal(supportsColor(fakeStream(true), { NO_COLOR: '' }), true);
});

test('NO_COLOR wins over FORCE_COLOR', () => {
  assert.equal(supportsColor(fakeStream(false), { NO_COLOR: '1', FORCE_COLOR: '1' }), false);
});

test('FORCE_COLOR enables color on a non-TTY', () => {
  assert.equal(supportsColor(fakeStream(false), { FORCE_COLOR: '1' }), true);
});

test('FORCE_COLOR=0 does not enable color', () => {
  assert.equal(supportsColor(fakeStream(false), { FORCE_COLOR: '0' }), false);
});

test('non-TTY disables color by default', () => {
  assert.equal(supportsColor(fakeStream(false), {}), false);
});

test('TTY enables color by default', () => {
  assert.equal(supportsColor(fakeStream(true), {}), true);
});

test('TERM=dumb disables color on a TTY', () => {
  assert.equal(supportsColor(fakeStream(true), { TERM: 'dumb' }), false);
});

test('level threshold suppresses lower-priority messages', () => {
  const stderr = fakeStream();
  const logger = createLogger({ stderr, stdout: fakeStream(), env: {}, level: 'warn' });
  logger.error('boom');
  logger.warn('careful');
  logger.info('fyi');
  logger.debug('noise');
  const text = stderr.text();
  assert.match(text, /boom/);
  assert.match(text, /careful/);
  assert.doesNotMatch(text, /fyi/);
  assert.doesNotMatch(text, /noise/);
});

test('silent level suppresses everything, including errors', () => {
  const stderr = fakeStream();
  const logger = createLogger({ stderr, stdout: fakeStream(), env: {}, level: 'silent' });
  logger.error('boom');
  assert.equal(stderr.text(), '');
});

test('WSC_LOG_LEVEL from env sets the threshold', () => {
  const stderr = fakeStream();
  const logger = createLogger({ stderr, stdout: fakeStream(), env: { WSC_LOG_LEVEL: 'debug' } });
  logger.debug('visible now');
  assert.match(stderr.text(), /visible now/);
});

test('an unknown level falls back to info instead of throwing', () => {
  const stderr = fakeStream();
  const logger = createLogger({ stderr, stdout: fakeStream(), env: {}, level: 'nonsense' });
  logger.info('still logged');
  logger.debug('too verbose');
  assert.match(stderr.text(), /still logged/);
  assert.doesNotMatch(stderr.text(), /too verbose/);
});

test('out() writes to stdout while diagnostics go to stderr', () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const logger = createLogger({ stdout, stderr, env: {} });
  logger.out('data line');
  logger.info('status line');
  assert.equal(stdout.text(), 'data line\n');
  assert.match(stderr.text(), /status line/);
  assert.doesNotMatch(stdout.text(), /status line/);
});

test('no ANSI escapes are emitted when color is off', () => {
  const stderr = fakeStream(false);
  const logger = createLogger({ stderr, stdout: fakeStream(), env: {} });
  logger.error('plain');
  logger.tagged('web', 'a line');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(stderr.text(), /\x1b\[/);
});

test('ANSI escapes are emitted when color is on', () => {
  const stderr = fakeStream(true);
  const logger = createLogger({ stderr, stdout: fakeStream(), env: {} });
  logger.error('painted');
  // eslint-disable-next-line no-control-regex
  assert.match(stderr.text(), /\x1b\[31m/);
});

test('color is decided by stderr, not stdout', () => {
  // `wsc > file.txt` leaves stderr a TTY while stdout is redirected.
  const logger = createLogger({ stdout: fakeStream(false), stderr: fakeStream(true), env: {} });
  assert.equal(logger.color, true);
});

test('tagged() prefixes the line with the configuration name', () => {
  const stderr = fakeStream(false);
  const logger = createLogger({ stderr, stdout: fakeStream(), env: {} });
  logger.tagged('web', 'server started');
  assert.equal(stderr.text(), '[web] server started\n');
});

test('prefixColor is stable across calls for the same name', () => {
  assert.equal(prefixColor('web'), prefixColor('web'));
});

test('prefixColor returns an ANSI code for any name, including empty', () => {
  // eslint-disable-next-line no-control-regex
  assert.match(prefixColor(''), /^\x1b\[\d+m$/);
  // eslint-disable-next-line no-control-regex
  assert.match(prefixColor('api > repro:stale-job:debug'), /^\x1b\[\d+m$/);
});
