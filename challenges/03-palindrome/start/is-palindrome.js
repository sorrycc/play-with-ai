/** Whether `text` reads the same backwards. */
export function isPalindrome(text) {
	// TODO(card): ignore upper/lower case and spaces before comparing
	const clean = text;
	return clean === [...clean].reverse().join('');
}
