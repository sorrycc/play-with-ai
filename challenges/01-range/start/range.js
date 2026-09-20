/** The whole numbers from `start` up to, but not including, `end`. */
export function range(start, end) {
	const result = [];
	// TODO(card): count by `step` instead of always by 1
	for (let i = start; i < end; i += 1) {
		result.push(i);
	}

	return result;
}
