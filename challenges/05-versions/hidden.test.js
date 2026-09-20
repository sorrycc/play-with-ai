import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions} from './compare-versions.js';

test('card 05: parts compare as numbers', () => {
	assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
	assert.equal(compareVersions('9.9.9', '10.0.0'), -1);
});

test('card 05: a missing part counts as 0', () => {
	assert.equal(compareVersions('1.2', '1.2.0'), 0);
	assert.equal(compareVersions('1.2', '1.2.1'), -1);
});

test('card 05: what was right stays right', () => {
	assert.equal(compareVersions('2.1.0', '2.0.9'), 1);
	assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});
