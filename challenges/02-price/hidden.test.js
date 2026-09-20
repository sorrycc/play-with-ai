import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPrice} from './format-price.js';

test('card 02: the cents part is always two digits', () => {
	assert.equal(formatPrice(5), '$0.05');
	assert.equal(formatPrice(1200), '$12.00');
	assert.equal(formatPrice(1909), '$19.09');
});

test('card 02: prices that were right stay right', () => {
	assert.equal(formatPrice(1234), '$12.34');
});
