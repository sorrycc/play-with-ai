import test from 'node:test';
import assert from 'node:assert/strict';
import {render} from './render.js';

test('card 10: a dotted path walks into the values', () => {
	assert.equal(render('{user.name} is {user.age}', {user: {name: 'Ada', age: 36}}), 'Ada is 36');
});

test('card 10: a value that is not there stays as written', () => {
	assert.equal(render('Hi {nope}', {}), 'Hi {nope}');
	assert.equal(render('Hi {user.nope}', {user: {}}), 'Hi {user.nope}');
});

test('card 10: doubled braces are literal braces', () => {
	assert.equal(render('{{literal}}', {}), '{literal}');
});

test('card 10: 0 and false are written out', () => {
	assert.equal(render('{count} left', {count: 0}), '0 left');
	assert.equal(render('{on}', {on: false}), 'false');
});
