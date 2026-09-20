import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions} from './compare-versions.js';

test('tells older from newer', () => {
	assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
	assert.equal(compareVersions('2.1.0', '2.0.9'), 1);
});

test('knows the same version', () => {
	assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compares each part as a number', () => {
	assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
});
