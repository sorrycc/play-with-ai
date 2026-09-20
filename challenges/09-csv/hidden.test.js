import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsvLine} from './parse-csv-line.js';

test('card 09: a comma inside quotes is content', () => {
	assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
});

test('card 09: the quotes themselves are gone', () => {
	assert.deepEqual(parseCsvLine('"a","b"'), ['a', 'b']);
});

test('card 09: two quotes inside a quoted field are one quote', () => {
	assert.deepEqual(parseCsvLine('"she said ""hi"""'), ['she said "hi"']);
});

test('card 09: empty fields are kept, last one included', () => {
	assert.deepEqual(parseCsvLine('a,,b'), ['a', '', 'b']);
	assert.deepEqual(parseCsvLine('a,'), ['a', '']);
});
