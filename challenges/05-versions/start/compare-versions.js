/** Compares two dotted versions: -1 when `a` is older than `b`, 1 when newer, 0 when the same. */
export function compareVersions(a, b) {
	// TODO(card): versions are numbers separated by dots, not text
	if (a === b) {
		return 0;
	}

	return a < b ? -1 : 1;
}
