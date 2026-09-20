import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsvLine} from './parse-csv-line.js';

test('splits plain fields on the commas', () => {
	assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
	assert.deepEqual(parseCsvLine('one'), ['one']);
});

test('a comma inside quotes is not a separator', () => {
	assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
});
