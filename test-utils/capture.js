/**
 * Test helpers.
 *
 * NOTE: this file deliberately lives outside `test/` — Node 20's default
 * `node --test` discovery executes every `.js` file under `test/` as a test
 * file, which would turn helpers into phantom always-passing tests.
 */

/**
 * Minimal writable stub that records everything written to it.
 *
 * @param {boolean} [isTTY]
 * @returns {{ isTTY: boolean, write: (s: string) => void, text: () => string }}
 */
export function fakeStream(isTTY = false) {
  const chunks = [];
  return {
    isTTY,
    write: (s) => { chunks.push(s); return true; },
    text: () => chunks.join(''),
  };
}

/**
 * Run `fn` with process.stdout/stderr captured, so tests stay silent and can
 * assert on what was printed. Restores the original writers even if `fn` throws.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<{ result: T, stdout: string, stderr: string }>}
 */
export async function captureOutput(fn) {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let stdout = '';
  let stderr = '';

  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };

  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}
