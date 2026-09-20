/** A cache that should hold at most `capacity` entries, dropping the least recently used. */
export class LruCache {
	constructor(capacity) {
		this.capacity = capacity;
		this.map = new Map();
	}

	get(key) {
		return this.map.get(key);
	}

	set(key, value) {
		// TODO(card): it never drops anything, and it has no idea what was used recently
		this.map.set(key, value);
		return this;
	}

	/** The keys held, from the least to the most recently used. */
	keys() {
		return [...this.map.keys()];
	}
}
