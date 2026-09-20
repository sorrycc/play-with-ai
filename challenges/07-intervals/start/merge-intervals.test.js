import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeIntervals} from './merge-intervals.js';

test('leaves alone what needs no merging', () => {
	assert.deepEqual(mergeIntervals([]), []);
	assert.deepEqual(mergeIntervals([[1, 2]]), [[1, 2]]);
	assert.deepEqual(mergeIntervals([[1, 2], [4, 5]]), [[1, 2], [4, 5]]);
});
