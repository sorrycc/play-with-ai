import test from 'node:test';
import assert from 'node:assert/strict';
import {range} from './range.js';

test('counts from start up to, not including, end', () => {
	assert.deepEqual(range(1, 4), [1, 2, 3]);
	assert.deepEqual(range(0, 1), [0]);
});

test('is empty when there is nothing to count', () => {
	assert.deepEqual(range(3, 3), []);
	assert.deepEqual(range(5, 2), []);
});

test('counts by step', () => {
	assert.deepEqual(range(0, 10, 5), [0, 5]);
});
