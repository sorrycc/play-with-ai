/** One line of CSV as its fields. `a,b,c` is three fields; quotes may hold commas of their own. */
export function parseCsvLine(line) {
	// TODO(card): walk the line instead, and remember whether you are inside quotes
	return line.split(',');
}
