import test from 'node:test';
import assert from 'node:assert/strict';
import {groupBy} from './group-by.js';

test('nothing to group gives an empty object', () => {
	assert.deepEqual(groupBy([], 'type'), {});
	assert.deepEqual(groupBy([], item => item.type), {});
});
