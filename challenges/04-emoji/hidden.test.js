import test from 'ava';
import slugify from './index.js';

test('card 02: rocket and fire become words', t => {
	t.is(slugify('Ship it 🚀'), 'ship-it-rocket');
	t.is(slugify('🔥 hot take'), 'fire-hot-take');
});

test('card 02: custom replacements still win', t => {
	t.is(slugify('go 🚀', {customReplacements: [['🚀', ' launch ']]}), 'go-launch');
});

test('card 02: existing emoji keep working', t => {
	t.is(slugify('foo🦄'), 'foo-unicorn');
	t.is(slugify('I ♥ Dogs'), 'i-love-dogs');
});
