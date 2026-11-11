import { App, TFile, TFolder } from "obsidian";
import { TAG_SYMBOL, collectCanvasFiles, parseEdgeTag } from "./flowchartCanvas";
import { CodeSide, sideOf } from "./flowchartSides";

/**
 * Code links between flowchart nodes that are not plain calls — the links a
 * reader of a client/server timeline actually needs:
 *
 * - **call**: node A's code tags node B's code directly (a call, a reducer
 *   `rpc`, a mention).
 * - **table**: A's code writes a SpacetimeDB table that B's code reads,
 *   subscribes to or registers callbacks on — directly, or through a view
 *   (`B --read--> view --read--> table <--write-- A`). This is how a reducer
 *   on the server reaches a client card: the reducer writes `enemy`, the
 *   client reads the `nearby_enemies` view.
 * - **shared**: A and B are on different code sides (see flowchartSides.ts)
 *   and both use the same function in shared code (a symbol on neither
 *   side, e.g. `crates/kg_combat`) — directly or within `sharedDepth` hops
 *   inside the shared code. This is the link a plain call graph never shows:
 *   the client expands a volley with `kg_combat` and the server re-derives
 *   the same volley with the same function, so they agree.
 *
 * Everything is read off the generated symbol canvases' edge tags (see the
 * flowchartCanvas module doc) — no code model is built. Identities are
 * `<file><subpath>` (`server/x.rs#fn`, `#fn#2` for a later same-name
 * symbol), exactly as a symbol canvas's file node and a `[[file#symbol]]`
 * wikilink spell them.
 */

export interface CodeTarget {
	file: string;
	subpath: string;
	label?: string;
}

export interface CodeIndex {
	/** identity → its outgoing edge-tag targets (code targets only). */
	targets: Map<string, CodeTarget[]>;
	/** identity → the identities tagging it, with the tag label. */
	users: Map<string, { source: string; label?: string }[]>;
	/** Number of symbol canvases indexed. */
	symbols: number;
}

export type ParsedCanvas = { file: TFile; data: any; tags: string[] };

export function tagsFromData(data: any): string[] {
	const tags = data?.metadata?.frontmatter?.tags;
	if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === "string");
	if (typeof tags === "string") return [tags];
	return [];
}

/** Reads and parses every canvas under `tree` once (unparseable ones are skipped). */
export async function readTreeCanvases(app: App, tree: TFolder): Promise<Map<string, ParsedCanvas>> {
	const parsed = new Map<string, ParsedCanvas>();
	for (const f of collectCanvasFiles(tree)) {
		let data: any;
		try {
			data = JSON.parse(await app.vault.read(f));
		} catch {
			continue;
		}
		parsed.set(f.path, { file: f, data, tags: tagsFromData(data) });
	}
	return parsed;
}

/** The first file node carrying a symbol subpath (a symbol canvas's identity). */
export function symbolFileNode(data: any): { file: string; subpath: string } | null {
	const node = (Array.isArray(data?.nodes) ? data.nodes : []).find(
		(n: any) => n?.type === "file" && typeof n.file === "string" && typeof n.subpath === "string",
	);
	return node ? { file: node.file, subpath: node.subpath } : null;
}

export function identityOf(file: string, subpath: string): string {
	return `${file}${subpath}`;
}

/** `server/x.rs#fn#2` → `fn`; a whole-file identity → its basename. */
export function symbolNameOf(identity: string): string {
	const hash = identity.indexOf("#");
	if (hash < 0) return identity.split("/").pop() ?? identity;
	return identity.slice(hash + 1).split("#")[0];
}

function filePartOf(identity: string): string {
	const hash = identity.indexOf("#");
	return hash < 0 ? identity : identity.slice(0, hash);
}

/** Builds the identity → targets / users index from a tree's symbol canvases. */
export function buildCodeIndex(parsed: Map<string, ParsedCanvas>): CodeIndex {
	const targets = new Map<string, CodeTarget[]>();
	const users = new Map<string, { source: string; label?: string }[]>();
	let symbols = 0;
	for (const p of parsed.values()) {
		if (!p.tags.includes(TAG_SYMBOL)) continue;
		const node = symbolFileNode(p.data);
		if (!node) continue;
		symbols++;
		const id = identityOf(node.file, node.subpath);
		const list = targets.get(id) ?? [];
		for (const tag of p.tags) {
			const t = parseEdgeTag(tag);
			if (!t || t.file.endsWith(".canvas")) continue; // aggregate-chain tags
			list.push(t);
			const tid = identityOf(t.file, t.subpath);
			const u = users.get(tid) ?? [];
			u.push({ source: id, label: t.label });
			users.set(tid, u);
		}
		targets.set(id, list);
	}
	return { targets, users, symbols };
}

/**
 * The code identities a doc heading's section links to: every
 * `[[file#symbol]]` link (or embed) between the heading and the next heading
 * of the same or a higher level, resolved to a vault code file. Whole-file
 * links are skipped (too coarse to link two cards by). Needs the doc in the
 * metadata cache.
 */
export function docSectionCodeIdentities(app: App, doc: TFile, heading: string): string[] {
	const cache = app.metadataCache.getFileCache(doc);
	const headings = cache?.headings ?? [];
	const idx = headings.findIndex((h) => h.heading === heading);
	if (idx < 0) return [];
	const h = headings[idx];
	const start = h.position.start.line;
	let end = Number.POSITIVE_INFINITY;
	for (let i = idx + 1; i < headings.length; i++) {
		if (headings[i].level <= h.level) {
			end = headings[i].position.start.line;
			break;
		}
	}
	const out = new Set<string>();
	for (const l of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
		const line = l.position.start.line;
		if (line <= start || line >= end) continue;
		// `\|` inside a table leaves the backslash on the link path.
		const raw = l.link.replace(/\\$/, "");
		const hash = raw.indexOf("#");
		if (hash <= 0) continue;
		const sub = raw.slice(hash);
		if (sub.startsWith("#^")) continue; // block refs
		const dest = app.metadataCache.getFirstLinkpathDest(raw.slice(0, hash), doc.path);
		if (!dest || dest.extension === "md" || dest.extension === "canvas") continue;
		out.add(identityOf(dest.path, sub));
	}
	return [...out];
}

export type LinkKind = "call" | "table" | "shared";

export interface DerivedLink {
	from: string;
	to: string;
	kind: LinkKind;
	/** Display label (`` `nearby_enemies` ``, `` shares `expand` ``). */
	label: string;
	/** The code identities that make the link (source side first). */
	via: string[];
}

export interface DeriveOptions {
	kinds: LinkKind[];
	sides: CodeSide[];
	/** Hops followed inside shared code for `shared` links (1 = direct use only). */
	sharedDepth: number;
	/** A shared symbol used by more than this many nodes is too common to link by. */
	sharedMaxUsers: number;
	/** Path globs (`crates/kg_hex/**`) whose symbols never make a `shared` link. */
	sharedIgnore: string[];
	/**
	 * A call/table end identity linked by more than this many nodes is too
	 * common to link by (a `WorldModel` every client card mentions).
	 */
	maxUsers: number;
	/**
	 * `functions` (default): call links only land on function-looking targets
	 * (a lowercase/underscore first letter outside `.cs` files — a type
	 * mention is not a beat handing off to another); `all`: any target.
	 */
	callTargets: "functions" | "all";
	/** `all` (default): a target covered by several nodes links to all of them; `nearest`: see deriveLinks. */
	resolve?: "all" | "nearest";
	/** Time order of the nodes for `nearest` (smaller = earlier); default: `nodes` order. */
	order?: Map<string, number>;
	/** Lane group of each node for `nearest` (one nearest target per group). */
	laneKey?: Map<string, string>;
	/**
	 * Hops of plain calls followed when looking for table writes and reads
	 * (0 = the node's own code only): a reducer that writes through a helper
	 * still hands its table to the readers.
	 */
	tableDepth?: number;
	/**
	 * `table` (default): nearest-mode table links resolve per written table;
	 * `writer`: per writer — a node hands its data to the nearest reader per
	 * lane group, whatever table it reads (the quiet setting for flows whose
	 * links ARE the chart).
	 */
	tableResolve?: "table" | "writer";
	/** Plain-call hops followed for call links (1 = direct calls only), through code no other node shows. */
	callDepth?: number;
	/** `all` (default): any shared symbol links two nodes; `functions`: only function-looking ones (no shared types). */
	sharedTargets?: "all" | "functions";
	/** `full` (default): call links are labelled `rpc \`x\``/`\`x\``; `network`: only labelled (reducer/table) calls get a label. */
	callLabels?: "full" | "network";
}

export interface LinkNode {
	id: string;
	identities: string[];
	/**
	 * The code sides this node runs on (a timeline lane's `side`). Shared code
	 * a node links directly (a card whose section links `kg_combat` itself)
	 * then counts as used by these sides; without them it has no side and only
	 * shared code reached *from* side code counts.
	 */
	sides?: string[];
}

const READ_LABELS = new Set(["read", "subscribe", "callback"]);

/** `*` within a segment, `**` across segments; matched against the whole path. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	const g = glob.replace(/\\/g, "/");
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*" && g[i + 1] === "*") {
			re += ".*";
			i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else {
			re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * Derives call / table / shared links between `nodes` from the code index.
 * One link per (from, to, kind); a pair linked by several identities keeps
 * the first label found (call/table) or the most specific shared symbol (the
 * one the fewest nodes use). `shared` links are undirected — they are
 * emitted once per pair, `from` being the earlier node in `nodes` order.
 *
 * With `resolve: "nearest"` (timeline flows whose links ARE the chart), a
 * target covered by several nodes — the same function shown in two beats —
 * links only to the nearest of them in time per lane group (`order`, later
 * nodes preferred over earlier ones), instead of to all of them.
 */
export function deriveLinks(index: CodeIndex, nodes: LinkNode[], opts: DeriveOptions): DerivedLink[] {
	const order = new Map(nodes.map((n, i) => [n.id, opts.order?.get(n.id) ?? i]));
	const nodesByIdentity = new Map<string, Set<string>>();
	for (const n of nodes) {
		for (const id of n.identities) {
			const set = nodesByIdentity.get(id) ?? new Set<string>();
			set.add(n.id);
			nodesByIdentity.set(id, set);
		}
	}
	const laneKey = new Map(nodes.map((n) => [n.id, opts.laneKey?.get(n.id) ?? ""]));
	const out = new Map<string, DerivedLink>();
	/** Nearest-mode candidates: `${from}|${kind}|${target key}` → links to choose from. */
	const pending = new Map<string, DerivedLink[]>();
	const put = (l: DerivedLink, targetKey?: string) => {
		if (l.from === l.to) return;
		if (opts.resolve === "nearest" && targetKey !== undefined) {
			const k = `${l.from}|${l.kind}|${targetKey}`;
			const list = pending.get(k) ?? [];
			list.push(l);
			pending.set(k, list);
			return;
		}
		const key = `${l.from}->${l.to}#${l.kind}`;
		if (!out.has(key)) out.set(key, l);
	};
	const kinds = new Set(opts.kinds);
	const idsOf = new Map(nodes.map((n) => [n.id, new Set(n.identities)]));
	/** Identities specific enough to link two nodes by. */
	const specific = (identity: string) => (nodesByIdentity.get(identity)?.size ?? 0) <= opts.maxUsers;
	/**
	 * `b`'s nodes that do not link `from` themselves: two cards that both
	 * link a function are not linked by what that function calls.
	 */
	const endsOf = (identity: string, fromIdentity: string): string[] =>
		[...(nodesByIdentity.get(identity) ?? [])].filter((b) => !idsOf.get(b)?.has(fromIdentity));
	/** Function-looking symbol: lowercase/underscore first letter (any `.cs` symbol, where methods are PascalCase). */
	const functionLike = (identity: string) => filePartOf(identity).endsWith(".cs") || /^[a-z_]/.test(symbolNameOf(identity));
	const callable = (identity: string) => opts.callTargets === "all" || functionLike(identity);
	const tick = (name: string) => `\`${name}\``;

	if (kinds.has("call")) {
		const callDepth = Math.max(1, opts.callDepth ?? 1);
		const ownedByOther = (identity: string, owner: string) => [...(nodesByIdentity.get(identity) ?? [])].some((x) => x !== owner);
		for (const a of nodes) {
			for (const ai of a.identities) {
				// Hop 1: every tag (reducer calls included). Further hops (`callDepth`):
				// plain calls only, through code no other node shows.
				let frontier: { id: string; path: string[] }[] = [{ id: ai, path: [ai] }];
				const seen = new Set([ai]);
				for (let depth = 1; depth <= callDepth && frontier.length > 0; depth++) {
					const next: { id: string; path: string[] }[] = [];
					for (const cur of frontier) {
						for (const t of index.targets.get(cur.id) ?? []) {
							if (!t.subpath || (depth > 1 && t.label)) continue;
							const ti = identityOf(t.file, t.subpath);
							if (seen.has(ti)) continue;
							seen.add(ti);
							const path = [...cur.path, ti];
							if (specific(ti) && callable(ti) && !idsOf.get(a.id)!.has(ti)) {
								for (const b of endsOf(ti, ai)) {
									const name = tick(symbolNameOf(ti));
									const label = opts.callLabels === "network" ? (t.label ? name : "") : t.label ? `${t.label} ${name}` : name;
									put({ from: a.id, to: b, kind: "call", label, via: path }, ti);
								}
							}
							if (!t.label && !ownedByOther(ti, a.id)) next.push({ id: ti, path });
						}
					}
					frontier = next;
				}
			}
		}
	}

	if (kinds.has("table")) {
		const depth = Math.max(0, opts.tableDepth ?? 0);
		/**
		 * Identities reachable from `start` over unlabelled (code-level) tags,
		 * `start` included. Stops at code another node shows: a callee that is
		 * its own card owns its writes and reads.
		 */
		const closure = (start: string, owner: string): string[] => {
			const seen = new Set([start]);
			let frontier = [start];
			for (let d = 0; d < depth && frontier.length > 0; d++) {
				const next: string[] = [];
				for (const cur of frontier) {
					for (const t of index.targets.get(cur) ?? []) {
						if (t.label || !t.subpath) continue;
						const ti = identityOf(t.file, t.subpath);
						if (seen.has(ti)) continue;
						seen.add(ti);
						if ([...(nodesByIdentity.get(ti) ?? [])].some((x) => x !== owner)) continue;
						next.push(ti);
					}
				}
				frontier = next;
			}
			return [...seen].filter((x) => x === start || ![...(nodesByIdentity.get(x) ?? [])].some((y) => y !== owner));
		};
		/** table → how each node reaches it as a reader (the view it reads through, or the table itself). */
		const readersOf = new Map<string, { node: string; via: string; reader: string }[]>();
		for (const b of nodes) {
			for (const bi of b.identities) {
				for (const r of depth > 0 ? closure(bi, b.id) : [bi]) {
					for (const t of index.targets.get(r) ?? []) {
						if (!READ_LABELS.has(t.label ?? "")) continue;
						const ti = identityOf(t.file, t.subpath);
						const addReader = (table: string, via: string) => {
							const list = readersOf.get(table) ?? [];
							list.push({ node: b.id, via, reader: bi });
							readersOf.set(table, list);
						};
						addReader(ti, ti);
						// Through a view: the read target itself reads tables.
						for (const vt of index.targets.get(ti) ?? []) {
							if (vt.label === "read") addReader(identityOf(vt.file, vt.subpath), ti);
						}
					}
				}
			}
		}
		for (const a of nodes) {
			for (const ai of a.identities) {
				for (const w of depth > 0 ? closure(ai, a.id) : [ai]) {
					for (const t of index.targets.get(w) ?? []) {
						if (t.label !== "write") continue;
						const table = identityOf(t.file, t.subpath);
						for (const r of readersOf.get(table) ?? []) {
							if (r.node === a.id || idsOf.get(r.node)!.has(ai)) continue;
							if (!specific(r.reader)) continue;
							put(
								{ from: a.id, to: r.node, kind: "table", label: tick(symbolNameOf(r.via)), via: [ai, table, r.via, r.reader] },
								opts.tableResolve === "writer" ? "" : table,
							);
						}
					}
				}
			}
		}
	}

	if (kinds.has("shared")) {
		const ignore = opts.sharedIgnore.map(globToRegExp);
		const ignored = (identity: string) => ignore.some((re) => re.test(filePartOf(identity)));
		/** shared identity → node id → the sides that reach it from that node (+ the reaching identity). */
		const reach = new Map<string, Map<string, { sides: Set<string>; from: string }>>();
		for (const n of nodes) {
			const record = (ti: string, sides: string[], from: string) => {
				let m = reach.get(ti);
				if (!m) reach.set(ti, (m = new Map()));
				let e = m.get(n.id);
				if (!e) m.set(n.id, (e = { sides: new Set(), from }));
				for (const s of sides) e.sides.add(s);
			};
			for (const start of n.identities) {
				const own = sideOf(filePartOf(start), opts.sides);
				const startIsShared = opts.sides.length > 0 ? own === null : false;
				// Side code reaches shared code; shared code the node links itself is
				// used by the node's own sides (its lane's `side`), when it has any.
				const sides = own && !startIsShared ? [own] : startIsShared && n.sides?.length ? n.sides : [];
				if (sides.length === 0) continue;
				if (startIsShared) {
					if (ignored(start)) continue;
					record(start, sides, start);
				}
				const side = sides[0];
				// BFS inside code that is on neither this side nor (if any) another named side.
				let frontier = [start];
				const seen = new Set<string>([start]);
				for (let d = 0; d < Math.max(1, opts.sharedDepth) && frontier.length > 0; d++) {
					const next: string[] = [];
					for (const cur of frontier) {
						for (const t of index.targets.get(cur) ?? []) {
							// Only code-level uses (unlabelled mentions/calls): a labelled tag
							// is a reducer call or a table access, which crosses the network.
							if (!t.subpath || t.label) continue;
							const ti = identityOf(t.file, t.subpath);
							if (seen.has(ti)) continue;
							seen.add(ti);
							// Shared code: no side when sides are configured, else another
							// top-level folder than this node's.
							const tSide = sideOf(t.file, opts.sides);
							const isShared = opts.sides.length > 0 ? tSide === null : tSide !== side;
							if (!isShared || ignored(ti)) continue;
							if (opts.sharedTargets === "functions" && !functionLike(ti)) {
								next.push(ti); // walk through types, but never link by one
								continue;
							}
							record(ti, sides, start);
							next.push(ti);
						}
					}
					frontier = next;
				}
			}
		}
		const best = new Map<string, { link: DerivedLink; users: number }>();
		for (const [shared, byNode] of reach) {
			if (byNode.size < 2 || byNode.size > opts.sharedMaxUsers) continue;
			const ids = [...byNode.keys()].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
			for (let i = 0; i < ids.length; i++) {
				for (let j = i + 1; j < ids.length; j++) {
					const ea = byNode.get(ids[i])!;
					const eb = byNode.get(ids[j])!;
					// Different sides on the two ends (one side using it twice is not "shared").
					const cross = [...ea.sides].some((s) => [...eb.sides].some((t) => t !== s));
					if (!cross) continue;
					const key = `${ids[i]}->${ids[j]}`;
					const prev = best.get(key);
					if (prev && prev.users <= byNode.size) continue;
					best.set(key, {
						users: byNode.size,
						link: {
							from: ids[i],
							to: ids[j],
							kind: "shared",
							label: `shares ${tick(symbolNameOf(shared))}`,
							via: [ea.from, shared, eb.from],
						},
					});
				}
			}
		}
		for (const { link } of best.values()) put(link);
	}

	// Nearest mode: per (from, kind, target), keep the nearest node in time per lane group.
	for (const list of pending.values()) {
		const from = order.get(list[0].from) ?? 0;
		const byLane = new Map<string, DerivedLink>();
		const dist = (l: DerivedLink) => {
			const d = (order.get(l.to) ?? 0) - from;
			return d > 0 ? d : 1e12 - d; // later nodes first, then the closest earlier one
		};
		for (const l of list) {
			const k = laneKey.get(l.to) ?? "";
			const prev = byLane.get(k);
			if (!prev || dist(l) < dist(prev)) byLane.set(k, l);
		}
		for (const l of byLane.values()) {
			const key = `${l.from}->${l.to}#${l.kind}`;
			if (!out.has(key)) out.set(key, l);
		}
	}

	return [...out.values()];
}
