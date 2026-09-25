#!/usr/bin/env node
/**
 * The decisions a release workflow makes that are worth a unit test: does the tag really
 * name the version in the repository, and what are its release notes. Kept out of the YAML
 * so a mistake in either fails `npm test`, not a release.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} tag - e.g. `v0.1.0`, `plugin-v0.5.1`
 * @param {string} prefix - `v` or `plugin-v`
 * @param {string} version - from package.json or build.gradle.kts
 * @returns {{ prerelease: boolean }}
 */
export function checkReleaseTag(tag, prefix, version) {
    if (tag !== `${prefix}${version}`) {
        throw new Error(`tag ${tag} does not name the version in the repository (${version}); expected ${prefix}${version}`);
    }
    return { prerelease: version.includes('-') };
}

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} markdown - CHANGELOG.md
 * @param {'cli' | 'plugin'} component
 * @param {string} version
 * @returns {string}
 */
export function changelogSection(markdown, component, version) {
    const heading = new RegExp(`^## \\[${component} ${escapeRegExp(version)}\\].*$`, 'm');
    const match = heading.exec(markdown);
    if (!match) throw new Error(`no CHANGELOG entry for ${component} ${version}`);
    const rest = markdown.slice(match.index + match[0].length);
    const next = rest.search(/^## /m);
    return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * The plugin's version, as `ide-plugin/build.gradle.kts` sets it — the one place it lives.
 *
 * @param {string} buildGradleKts
 * @returns {string}
 */
export function gradleVersion(buildGradleKts) {
    const match = /^version\s*=\s*"([^"]+)"\s*$/m.exec(buildGradleKts);
    if (!match) throw new Error('no version = "…" line in build.gradle.kts');
    return match[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, ...args] = process.argv.slice(2);
    try {
        if (command === 'check') {
            const [tag, prefix, version] = args;
            console.log(`prerelease=${checkReleaseTag(tag, prefix, version).prerelease}`);
        } else if (command === 'notes') {
            const [component, version] = args;
            const file = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
            console.log(changelogSection(readFileSync(file, 'utf8'), /** @type {'cli' | 'plugin'} */ (component), version));
        } else if (command === 'gradle-version') {
            const file = fileURLToPath(new URL('../ide-plugin/build.gradle.kts', import.meta.url));
            console.log(gradleVersion(readFileSync(file, 'utf8')));
        } else {
            throw new Error('usage: release.js check <tag> <prefix> <version> | notes <cli|plugin> <version> | gradle-version');
        }
    } catch (err) {
        console.error(`release: ${/** @type {Error} */ (err).message}`);
        process.exit(1);
    }
}
