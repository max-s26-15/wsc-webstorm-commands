import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { changelogSection, checkReleaseTag } from '../scripts/release.js';

describe('checkReleaseTag', () => {
    test('a matching tag passes', () => {
        assert.deepEqual(checkReleaseTag('v0.1.0', 'v', '0.1.0'), { prerelease: false });
        assert.deepEqual(checkReleaseTag('plugin-v0.5.1', 'plugin-v', '0.5.1'), { prerelease: false });
    });

    test('a pre-release suffix is reported, so it can publish under "next"', () => {
        assert.deepEqual(checkReleaseTag('v0.2.0-rc.1', 'v', '0.2.0-rc.1'), { prerelease: true });
    });

    test('a tag that does not equal the version stops the release', () => {
        assert.throws(() => checkReleaseTag('v0.1.0', 'v', '0.1.1'), /tag v0\.1\.0 .*\(0\.1\.1\)/);
        assert.throws(() => checkReleaseTag('plugin-v0.5.1', 'plugin-v', '0.5.2'), /tag plugin-v0\.5\.1 .*\(0\.5\.2\)/);
    });

    test("the other component's tag is not this one's", () => {
        assert.throws(() => checkReleaseTag('plugin-v0.1.0', 'v', '0.1.0'));
    });
});

describe('changelogSection', () => {
    const md = [
        '# Changelog',
        '',
        '## [cli 0.2.0] - 2026-10-01',
        '### Fixed',
        '- b',
        '',
        '## [plugin 0.5.1] - 2026-09-30',
        '- p',
        '',
        '## [cli 0.1.0] - 2026-09-30',
        '- a',
        '',
    ].join('\n');

    test("returns the body of that component's version, trimmed", () => {
        assert.equal(changelogSection(md, 'cli', '0.2.0'), '### Fixed\n- b');
        assert.equal(changelogSection(md, 'plugin', '0.5.1'), '- p');
        assert.equal(changelogSection(md, 'cli', '0.1.0'), '- a');
    });

    test('a version with no entry stops the release', () => {
        assert.throws(() => changelogSection(md, 'cli', '9.9.9'), /no CHANGELOG entry for cli 9\.9\.9/);
    });

    test('dots in a version are literal', () => {
        assert.throws(() => changelogSection(md, 'cli', '0x1.0'));
    });
});
