import test from 'node:test';
import assert from 'node:assert/strict';
import {render} from './render.js';

test('fills in a plain name', () => {
	assert.equal(render('Hi {name}', {name: 'Ada'}), 'Hi Ada');
	assert.equal(render('nothing to fill', {}), 'nothing to fill');
});

test('walks a dotted path', () => {
	assert.equal(render('{user.name}', {user: {name: 'Ada'}}), 'Ada');
});
