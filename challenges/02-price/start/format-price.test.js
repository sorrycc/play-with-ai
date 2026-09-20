import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPrice} from './format-price.js';

test('formats cents as dollars', () => {
	assert.equal(formatPrice(1234), '$12.34');
	assert.equal(formatPrice(99), '$0.99');
	assert.equal(formatPrice(100_050), '$1000.50');
});

test('pads the cents part to two digits', () => {
	assert.equal(formatPrice(5), '$0.05');
});
