import test from 'node:test';
import assert from 'node:assert/strict';
import {groupBy} from './group-by.js';

test('card 06: groups by a property name, keeping the order', () => {
	assert.deepEqual(groupBy([{t: 'a', n: 1}, {t: 'b', n: 2}, {t: 'a', n: 3}], 't'), {a: [{t: 'a', n: 1}, {t: 'a', n: 3}], b: [{t: 'b', n: 2}]});
});

test('card 06: groups by a function', () => {
	assert.deepEqual(groupBy([1, 2, 3, 4], n => (n % 2 ? 'odd' : 'even')), {odd: [1, 3], even: [2, 4]});
});

test('card 06: nothing to group is still an empty object', () => {
	assert.deepEqual(groupBy([], 't'), {});
});
