import test from 'node:test';
import assert from 'node:assert/strict';
import {LruCache} from './lru-cache.js';

test('card 08: over capacity, the least recently used entry goes', () => {
	assert.deepEqual(new LruCache(2).set('a', 1).set('b', 2).set('c', 3).keys(), ['b', 'c']);
	assert.equal(new LruCache(2).set('a', 1).set('b', 2).set('c', 3).get('a'), undefined);
});

test('card 08: get counts as a use', () => {
	const c = new LruCache(2).set('a', 1).set('b', 2);
	assert.equal(c.get('a'), 1);
	assert.deepEqual(c.set('c', 3).keys(), ['a', 'c']);
});

test('card 08: setting a key that is already there counts as a use and drops nothing', () => {
	assert.deepEqual(new LruCache(2).set('a', 1).set('b', 2).set('a', 9).keys(), ['b', 'a']);
	assert.deepEqual(new LruCache(2).set('a', 1).set('b', 2).set('a', 9).set('c', 3).keys(), ['a', 'c']);
});

test('card 08: a get that misses changes nothing', () => {
	const c = new LruCache(2).set('a', 1).set('b', 2);
	assert.equal(c.get('zzz'), undefined);
	assert.deepEqual(c.keys(), ['a', 'b']);
});
