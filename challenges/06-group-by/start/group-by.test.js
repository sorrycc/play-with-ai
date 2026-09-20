import test from 'node:test';
import assert from 'node:assert/strict';
import {groupBy} from './group-by.js';

test('nothing to group gives an empty object', () => {
	assert.deepEqual(groupBy([], 'type'), {});
	assert.deepEqual(groupBy([], item => item.type), {});
});

test('groups by a property name', () => {
	assert.deepEqual(groupBy([{t: 'a', n: 1}, {t: 'b', n: 2}], 't'), {a: [{t: 'a', n: 1}], b: [{t: 'b', n: 2}]});
});
