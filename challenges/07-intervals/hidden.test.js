import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeIntervals} from './merge-intervals.js';

test('card 07: merges intervals that overlap', () => {
	assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
});

test('card 07: the input need not be sorted', () => {
	assert.deepEqual(mergeIntervals([[8, 10], [2, 6], [1, 3]]), [[1, 6], [8, 10]]);
});

test('card 07: intervals that only touch are merged too', () => {
	assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
});

test('card 07: an interval inside another disappears into it', () => {
	assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
});

test('card 07: the array passed in is not changed', () => {
	const input = [[8, 10], [1, 3], [2, 6]];
	mergeIntervals(input);
	assert.deepEqual(input, [[8, 10], [1, 3], [2, 6]]);
});
