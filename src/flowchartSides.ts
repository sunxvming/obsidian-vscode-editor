/**
 * Code "sides" — which deployable a vault code file belongs to (the server,
 * the client, a bot, …), so the flowchart and pointer generators can tell
 * when one function is linked into more than one of them.
 *
 * Configured in the settings tab (`settings.codeSides`, one side per line):
 *
 *   server: server/
 *   client: client/, tools/kg_bot/
 *
 * Each line is `<name>: <vault path prefix>[, <prefix>…]`. A file belongs to
 * the side of the **longest** matching prefix (prefixes are matched
 * segment-aligned and case-insensitively; a trailing `/` is optional). Files
 * no prefix matches have no side (`null`) — that is where shared crates live
 * (`crates/` above), and it is what makes a symbol in them "shared" when two
 * different sides use it.
 *
 * A side named `shared` is reserved: its prefixes mark shared code inside
 * another side's tree (`shared: online/crates/kg_protocol/` next to
 * `client: online/`) — longest prefix wins, so those files get no side.
 *
 * With nothing configured every file's side is its first path segment
 * (`server/…` → `server`, `crates/…` → `crates`), which is a usable default
 * for a repo laid out by deployable.
 *
 * A flow in flows.json may override the setting with its own
 * `"sides": { "server": ["server/"], "client": ["client/"] }` object.
 */

export interface CodeSide {
	name: string;
	/** Lowercased, `/`-terminated vault path prefixes. */
	prefixes: string[];
}

/** Parses the settings text (or a flows.json `sides` object) into sides. Bad lines are skipped. */
export function parseCodeSides(value: unknown): CodeSide[] {
	const out: CodeSide[] = [];
	const add = (name: string, prefixes: unknown[]) => {
		const clean = prefixes
			.filter((p): p is string => typeof p === "string")
			.map((p) => p.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
			.filter((p) => p.length > 0)
			.map((p) => (p.endsWith("/") ? p : `${p}/`).toLowerCase());
		if (name.trim() && clean.length > 0) out.push({ name: name.trim(), prefixes: clean });
	};
	if (typeof value === "string") {
		for (const raw of value.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const colon = line.indexOf(":");
			if (colon <= 0) continue;
			add(line.slice(0, colon), line.slice(colon + 1).split(","));
		}
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [name, prefixes] of Object.entries(value as Record<string, unknown>)) {
			add(name, Array.isArray(prefixes) ? prefixes : [prefixes]);
		}
	}
	return out;
}

/**
 * The side a vault path belongs to: the longest configured prefix match, or
 * the first path segment when no sides are configured at all. `null` when
 * sides are configured and none matches (shared code).
 */
export function sideOf(path: string, sides: CodeSide[]): string | null {
	const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
	if (sides.length === 0) {
		const slash = p.indexOf("/");
		return slash > 0 ? p.slice(0, slash) : null;
	}
	const lower = `${p.toLowerCase()}/`;
	let best: { name: string; len: number } | null = null;
	for (const side of sides) {
		for (const prefix of side.prefixes) {
			if (lower.startsWith(prefix) && (!best || prefix.length > best.len)) {
				best = { name: side.name, len: prefix.length };
			}
		}
	}
	if (!best || best.name.toLowerCase() === SHARED_SIDE) return null;
	return best.name;
}

/** Reserved side name whose prefixes mark shared code (no side). */
export const SHARED_SIDE = "shared";

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
