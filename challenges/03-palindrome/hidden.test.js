import test from 'node:test';
import assert from 'node:assert/strict';
import {isPalindrome} from './is-palindrome.js';

test('card 03: ignores case', () => {
	assert.equal(isPalindrome('Level'), true);
});

test('card 03: ignores spaces', () => {
	assert.equal(isPalindrome('never odd or even'), true);
	assert.equal(isPalindrome('Never odd or even'), true);
});

test('card 03: still says no', () => {
	assert.equal(isPalindrome('hello'), false);
	assert.equal(isPalindrome('Hello World'), false);
});
