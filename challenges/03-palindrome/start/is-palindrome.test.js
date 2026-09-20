import test from 'node:test';
import assert from 'node:assert/strict';
import {isPalindrome} from './is-palindrome.js';

test('knows a palindrome', () => {
	assert.equal(isPalindrome('level'), true);
	assert.equal(isPalindrome('上海自来水来自海上'), true);
});

test('knows what is not one', () => {
	assert.equal(isPalindrome('hello'), false);
});
