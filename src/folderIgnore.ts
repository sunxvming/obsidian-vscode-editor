/**
 * Folder-ignore patterns for the code-scanning features (flowchart generation
 * and the generated pointer files).
 *
 * `settings.ignoredFolders` holds one pattern per entry (the settings tab
 * accepts a comma- or newline-separated list). A pattern is matched against
 * the vault-relative folder path, segment-aligned at both ends, so a bare name
 * ignores that folder anywhere in the vault:
 *
 *   target                  any folder named `target`, at any depth (and its whole subtree)
 *   docs/AI/REFERENCES      that exact path only
 *   server/target           a specific path
 *   generated?              any folder whose name looks generated (`?` = one char)
 *   client/<segment>/bindings  `*` matches within one path segment
 *
 * A `*` matches any run of characters inside one path segment, `**` matches
 * across segments, `?` matches a single character. Matching is
 * case-insensitive (Windows/OneDrive vaults are, and so is Obsidian's folder
 * lookup in practice). Patterns are matched against FOLDERS only — file-level
 * exclusions stay in `SKIP_DIR_NAMES`, `GENERATED_DIR_NAMES` and the
 * `*.g.cs` rule in flowchartModel.ts.
 */

/** Compiled pattern cache — the vault walk tests one path against every pattern. */
const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_LIMIT = 128;

/** Trimmed, slash-normalised patterns with blanks and duplicates dropped (case-insensitive dedupe). */
export function parseIgnorePatterns(raw: unknown): string[] {
	const list = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(/[\n,]/)
			: [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		if (typeof entry !== "string") continue;
		const pattern = entry.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (pattern.length === 0 || pattern === ".") continue;
		const key = pattern.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(pattern);
	}
	return out;
}

/** Glob pattern → segment-aligned, case-insensitive matcher for a folder path. */
function regexFor(pattern: string): RegExp {
	const cached = regexCache.get(pattern);
	if (cached) return cached;
	let body = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				body += ".*";
				i++;
			} else {
				body += "[^/]*";
			}
		} else if (ch === "?") {
			body += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(ch)) {
			body += `\\${ch}`;
		} else {
			body += ch;
		}
	}
	const regex = new RegExp(`(?:^|/)${body}(?:/|$)`, "i");
	if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear();
	regexCache.set(pattern, regex);
	return regex;
}

/** True when `path` (vault-relative) is one of the ignored folders or lives under one. */
export function isIgnoredFolderPath(path: string, patterns: string[]): boolean {
	if (patterns.length === 0 || !path) return false;
	const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
	return patterns.some((pattern) => regexFor(pattern).test(normalized));
}
