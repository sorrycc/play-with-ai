import test from 'node:test';
import assert from 'node:assert/strict';
import {range} from './range.js';

test('card 01: counts by step', () => {
	assert.deepEqual(range(0, 10, 5), [0, 5]);
	assert.deepEqual(range(1, 8, 3), [1, 4, 7]);
});

test('card 01: without step it still counts by 1', () => {
	assert.deepEqual(range(1, 4), [1, 2, 3]);
});
