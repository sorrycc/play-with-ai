import test from 'node:test';
import assert from 'node:assert/strict';
import {LruCache} from './lru-cache.js';

test('gives back what was set', () => {
	const cache = new LruCache(3).set('a', 1).set('b', 2);
	assert.equal(cache.get('a'), 1);
	assert.equal(cache.get('b'), 2);
	assert.equal(cache.get('nope'), undefined);
});

test('a key set again holds the new value', () => {
	assert.equal(new LruCache(3).set('a', 1).set('a', 2).get('a'), 2);
});

test('drops the least recently used when full', () => {
	assert.deepEqual(new LruCache(2).set('a', 1).set('b', 2).set('c', 3).keys(), ['b', 'c']);
});
