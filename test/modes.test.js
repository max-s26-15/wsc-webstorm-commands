import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as args from '../src/args.js';
import { DEFAULT_MODE, MODES } from '../src/modes.js';
import * as configureLogic from '../src/ui/configureLogic.js';
import * as store from '../src/presets/store.js';

describe('launch modes', () => {
    it('are run, debug and terminal, with run the default', () => {
        assert.deepEqual([...MODES], ['run', 'debug', 'terminal']);
        assert.equal(DEFAULT_MODE, 'run');
    });

    it('have one spelling: every module that names them re-exports the same list', () => {
        // A mode the preset file accepts but the command line does not (or the other way
        // round) is the failure this pins.
        assert.equal(args.MODES, MODES);
        assert.equal(store.MODES, MODES);
        assert.equal(args.DEFAULT_MODE, DEFAULT_MODE);
        assert.equal(configureLogic.DEFAULT_MODE, DEFAULT_MODE);
    });
});
