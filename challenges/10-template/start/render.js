/** Fills `{placeholder}` in `template` from `values`. */
export function render(template, values) {
	// TODO(card): dotted paths, {{ }} for a real brace, and a missing value stays as written
	return template.replaceAll(/{(\w+)}/g, (whole, name) => values[name]);
}
