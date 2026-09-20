/** A price in cents as dollars: 1234 becomes '$12.34'. */
export function formatPrice(cents) {
	const dollars = Math.floor(cents / 100);
	// TODO(card): the cents part must always be two digits
	const rest = String(cents % 100);
	return `$${dollars}.${rest}`;
}
