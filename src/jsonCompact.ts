/**
 * Human-friendly JSON: like `JSON.stringify(value, null, "\t")`, except that
 * any array or object whose single-line form fits in `width` columns (after
 * its indentation and key) is written on one line. flows.json uses it so a
 * hand-written timeline flow — one node or edge per line — survives the
 * plugin rewriting the manifest (membership edits, migrations) instead of
 * exploding into one line per property.
 */
export function stringifyCompact(value: unknown, width = 140, indent = "\t"): string {
	const render = (v: unknown, depth: number, prefixLen: number): string => {
		if (v === undefined) return "null";
		if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
		const pad = indent.repeat(depth);
		const one = spaced(v);
		const visual = pad.length * (indent === "\t" ? 4 : 1) + prefixLen + one.length;
		const isEmpty = Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0;
		if (isEmpty || (depth > 0 && visual <= width)) return one;
		const inner = indent.repeat(depth + 1);
		if (Array.isArray(v)) {
			const items = v.map((x) => `${inner}${render(x, depth + 1, 0)}`);
			return `[\n${items.join(",\n")}\n${pad}]`;
		}
		const entries = Object.entries(v as Record<string, unknown>)
			.filter(([, x]) => x !== undefined)
			.map(([k, x]) => {
				const key = `${JSON.stringify(k)}: `;
				return `${inner}${key}${render(x, depth + 1, key.length)}`;
			});
		return `{\n${entries.join(",\n")}\n${pad}}`;
	};
	return `${render(value, 0, 0)}\n`;
}

/** Single-line JSON with a space after `:` and `,` (readable, still valid JSON). */
function spaced(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map((x) => spaced(x)).join(", ")}]`;
	const entries = Object.entries(v as Record<string, unknown>)
		.filter(([, x]) => x !== undefined)
		.map(([k, x]) => `${JSON.stringify(k)}: ${spaced(x)}`);
	return `{${entries.join(", ")}}`;
}
