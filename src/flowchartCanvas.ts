import { App, TFile, TFolder, normalizePath } from "obsidian";
import dagre from "@dagrejs/dagre";
import CodeFilesPlugin from "./main";
import { FlowchartFile, FlowchartModel, toSnakeCase } from "./flowchartModel";
import { SymbolInfo } from "./symbolResolver";

/**
 * Turns a FlowchartModel into `.canvas` files:
 *
 *   <root>/flowcharts/
 *     Subflowcharts/<sub>/<File>_codefile/<File>_codefile.canvas   ← nodes for the file's declaration canvases
 *     Subflowcharts/<sub>/<File>_codefile/<symbol>_symbol.canvas   ← one narrowed symbol node per declaration
 *     Subflowcharts/<sub>/<Folder>_subfolder/<Folder>_subfolder.canvas ← nodes for contained file/folder canvases
 *     flows.json                                                   ← named flows (see flowchartFlows.ts)
 *     main.canvas / main-<name>.canvas                             ← composed from flows.json by flowchartAggregate.ts
 *
 * Every generated folder/canvas is suffixed with its granularity
 * (`_subfolder` / `_codefile` / `_symbol`, appended after every naming rule
 * below), and mirrored directory segments carry the `_subfolder` suffix too:
 * `src/Movement/walk.cs` with an `input` function yields
 * `Movement_subfolder/walk_codefile/input_symbol.canvas` next to
 * `Movement_subfolder/walk_codefile/walk_codefile.canvas` and
 * `Movement_subfolder/Movement_subfolder.canvas`.
 *
 * Every code file gets its own folder (named after the file's basename)
 * holding one canvas per declaration plus the file's own canvas, which
 * aggregates them. A folder's own canvas always lives *inside* its own
 * mirrored directory, alongside its contents
 * (`Subflowcharts/A_subfolder/B_subfolder/B_subfolder.canvas`, sitting next to
 * `Subflowcharts/A_subfolder/B_subfolder/foo_codefile/foo_codefile.canvas`
 * etc.), and aggregates the canvases of the files and folders it contains.
 *
 * Naming collisions are always resolved on the more specific side, so file
 * canvases keep plain names and vault folders keep plain mirrored names:
 * - Same-name declarations in one file (trait method vs impls, overloads,
 *   nested scopes) go through a three-rung ladder (`buildDeclNameMap`):
 *   container qualification (`MapConfig.seed_symbol.canvas`), then minimal
 *   distinguishing parameter types (`Move (float)_symbol.canvas` — shared
 *   parameters are omitted), then an occurrence number (`helper 2_symbol.canvas`;
 *   `#` is illegal in Obsidian file names) for genuinely identical duplicates
 *   such as #[cfg] variants. Non-colliding symbols keep the plain name.
 * - A declaration named the same as its own file (the common "Player.cs holds
 *   class Player" pattern) gets a " (kind)" suffix
 *   (`Player (class)_symbol.canvas`).
 * - A file named the same as a *sibling subfolder* (`Movement/move.cs` next
 *   to `Movement/move/`) gets a "File" suffix on its folder
 *   (`moveFile_codefile/move_codefile.canvas`).
 * (The last two rules predate the granularity suffixes, which already keep the
 * two sides apart; they are kept so names stay stable across the change.)
 * Both checks are case-insensitive (`Client` in `client.cs` still collides on
 * a case-insensitive filesystem); a cross-group case-only clash (trait `Seed`
 * next to fn `seed`) is likewise qualified with its container when one is
 * available. Any collision that survives those rules (e.g. same-basename
 * files with different extensions sharing one folder) falls back to "_"
 * prefixes on the generated file name, up to 5 (`claimCanvasPath`); canvases
 * still colliding after that are skipped and reported via
 * `GenerateResult.skipped`.
 * Generation warns about any such renames via `GenerateResult.renamedFiles`,
 * and reports canvases left over from earlier naming schemes (present before
 * the run, not written by it) via `GenerateResult.staleFiles`. Stale canvases
 * carrying a managed granularity tag are trashed instead when the
 * `pruneStaleFlowcharts` setting is on (reported via
 * `GenerateResult.prunedFiles`).
 *
 * Which sub-flowcharts appear in the flow canvases (main.canvas and named
 * main-<name>.canvas) is driven by `<root>/flowcharts/flows.json`, edited via
 * the "Include in flow ▸" / "Exclude from flow ▸" menu items (see
 * flowchartFlows.ts); "Generate aggregate flowchart from subflowchart
 * metadata" composes them (see flowchartAggregate.ts). Regenerating
 * sub-flowcharts preserves each canvas's metadata.
 *
 * Edges are tag-driven. Every generated symbol canvas records its outgoing
 * edges as metadata tags — one combined tag per edge:
 *
 *   edge-_colon_-<escaped file path>-_hashtag_-<escaped subpath>[-_colon_-<escaped label>]
 *
 * (`:` → `-_colon_-`, `.` → `-_dot_-`, `#` → `-_hashtag_-`, ` ` → `-_space_-`;
 * `/` is legal in tags and stays. Obsidian file names can't contain `#` or `:`,
 * so the first `-_hashtag_-` separates file from subpath and the first
 * `-_colon_-` after it starts the label.) A **whole-file target** (a `.tscn`
 * scene, or any file-level edge) omits the subpath entirely:
 * `edge-_colon_-<escaped file path>[-_colon_-<escaped label>]`.
 *
 * Every code-target edge also emits **aggregate-chain tags**: one whole-file
 * tag per aggregate canvas containing the target — the target file's
 * `<X>_codefile.canvas` plus each ancestor `<Y>_subfolder.canvas` up to the
 * root canvas — so the canvas-level connection graph is readable from the
 * tags alone. Chain tags reference the run's pre-claimed canvas paths
 * (collision prefixes included); a canvas never carries a chain tag naming
 * itself. Aggregating canvases derive their edges from their children's tags
 * and re-emit the union of all child edge tags as their own, so every
 * descendant's edges accumulate upward — this is what lets
 * `flowchartAggregate.ts` rebuild the whole aggregate tree from tags alone
 * (it re-derives chain tags structurally rather than trusting inherited
 * ones). Every generated canvas also carries a granularity tag (`symbol` /
 * `codefile` / `subfolder`), and is auto-tagged `includeInAggregateFlowchart`
 * on first creation (opt-out curation for aggregate generation; the flag is
 * preserved untouched on regeneration).
 *
 * Node and edge ids are deterministic (`stableId` of the node's stable key /
 * the edge's endpoints+label), so regenerating an unchanged tree rewrites
 * identical canvases, and `writeCanvas` carries each existing node's position
 * onto the regenerated node with the same id — user-dragged layouts survive
 * regeneration; new nodes get dagre positions. Positions come from a dagre
 * layered layout (top → bottom).
 */

/**
 * Granularity suffixes. Every generated folder and canvas carries the suffix of
 * the granularity it represents, appended *after* all the collision-resolving
 * naming rules below (`Movement_subfolder/walk_codefile/input_symbol.canvas`).
 * Mirrored directory segments get the folder suffix too, so a generated path
 * never collides with a plain vault path.
 */
export const SUFFIX_SUBFOLDER = "_subfolder";
export const SUFFIX_CODEFILE = "_codefile";
export const SUFFIX_SYMBOL = "_symbol";

const COLOR_REDUCER = "1"; // red — server entry points
export const COLOR_SUBFLOWCHART = "5"; // cyan — embedded sub-flowcharts

/**
 * Legacy opt-in flag for main.canvas membership (a tag in
 * `metadata.frontmatter.tags`). Superseded by flows.json (flowchartFlows.ts);
 * kept only so the one-time migration can read it.
 */
export const INCLUDE_FLAG = "includeInMainFlowchart";

/**
 * Opt-in flag for aggregate flowcharts (codefile/subfolder canvases). Added
 * automatically when a canvas is first generated; Include/Exclude menu items
 * toggle it afterwards. Distinct from flows.json membership, which gates the
 * flow canvases (main.canvas / main-<name>.canvas).
 */
export const AGGREGATE_INCLUDE_FLAG = "includeInAggregateFlowchart";

/** Granularity tags — every generated canvas carries exactly one. */
export const TAG_SYMBOL = "symbol";
export const TAG_CODEFILE = "codefile";
export const TAG_SUBFOLDER = "subfolder";

/** Prefix of the managed per-edge tags (see module doc for the format). */
export const EDGE_TAG_PREFIX = "edge-_colon_-";

const TAG_ESCAPES: [string, string][] = [
	[":", "-_colon_-"],
	[".", "-_dot_-"],
	["#", "-_hashtag_-"],
	[" ", "-_space_-"],
];

export function escapeTagSegment(s: string): string {
	for (const [raw, esc] of TAG_ESCAPES) s = s.split(raw).join(esc);
	return s;
}

export function unescapeTagSegment(s: string): string {
	for (const [raw, esc] of TAG_ESCAPES) s = s.split(esc).join(raw);
	return s;
}

/**
 * The one-tag-per-edge encoding: `edge-_colon_-<file>-_hashtag_-<subpath>`
 * with an optional `-_colon_-<label>` suffix. `subpath` keeps its leading `#`
 * (escaped to `-_hashtag_-`, which doubles as the file/subpath separator).
 * Whole-file targets (`.tscn` scenes, aggregate-chain canvases) omit the
 * subpath: `edge-_colon_-<file>[-_colon_-<label>]`.
 */
export function edgeTagFor(targetFile: string, subpath: string, label?: string): string {
	let tag = `${EDGE_TAG_PREFIX}${escapeTagSegment(targetFile)}${escapeTagSegment(subpath)}`;
	if (label) tag += `-_colon_-${escapeTagSegment(label)}`;
	return tag;
}

/** Inverse of `edgeTagFor`; null for tags that aren't edge tags. */
export function parseEdgeTag(tag: string): { file: string; subpath: string; label?: string } | null {
	if (!tag.startsWith(EDGE_TAG_PREFIX)) return null;
	const rest = tag.slice(EDGE_TAG_PREFIX.length);
	// Obsidian file names can't contain `#`, so the first hashtag escape marks
	// the start of the (leading-`#`) subpath. No hashtag escape → whole-file
	// target; file names can't contain `:` either, so the first colon escape
	// then starts the label.
	const hashIdx = rest.indexOf("-_hashtag_-");
	if (hashIdx < 0) {
		const colonIdx = rest.indexOf("-_colon_-");
		if (colonIdx < 0) return { file: unescapeTagSegment(rest), subpath: "" };
		return {
			file: unescapeTagSegment(rest.slice(0, colonIdx)),
			subpath: "",
			label: unescapeTagSegment(rest.slice(colonIdx + "-_colon_-".length)),
		};
	}
	const file = unescapeTagSegment(rest.slice(0, hashIdx));
	let rem = rest.slice(hashIdx);
	let label: string | undefined;
	// Symbol names can't contain `:`, so the first colon escape inside the
	// remainder starts the label (everything after it, escapes included).
	const colonIdx = rem.indexOf("-_colon_-");
	if (colonIdx >= 0) {
		label = unescapeTagSegment(rem.slice(colonIdx + "-_colon_-".length));
		rem = rem.slice(0, colonIdx);
	}
	return { file, subpath: unescapeTagSegment(rem), label };
}

/** Managed tags are refreshed on regeneration; all other tags are preserved. */
function isManagedTag(tag: string): boolean {
	return (
		tag === TAG_SYMBOL ||
		tag === TAG_CODEFILE ||
		tag === TAG_SUBFOLDER ||
		tag.startsWith(EDGE_TAG_PREFIX)
	);
}

export interface GenerateResult {
	outBase: string;
	fileCount: number;
	canvasCount: number;
	nodeCount: number;
	edgeCount: number;
	/** Generated paths that were qualified/suffixed to avoid a name collision — the file's folder ("File" suffix) or a declaration canvas (container/signature/occurrence qualifier, " (kind)" suffix). See module doc. */
	renamedFiles: string[];
	/** Desired canvas paths never written because even 5 "_" prefixes didn't resolve the collision. */
	skipped: string[];
	/**
	 * Pre-existing canvases under the generated tree that this run did not
	 * write — e.g. `seed 2.canvas` left behind after a naming-scheme change.
	 * Reported only, never auto-deleted (the tree may contain user canvases).
	 * Stale canvases carrying a managed granularity tag are trashed instead
	 * when `settings.pruneStaleFlowcharts` is on — see `prunedFiles`.
	 */
	staleFiles: string[];
	/**
	 * Stale canvases trashed by this run (`app.vault.trash`, not deleted):
	 * pre-existing canvases carrying a managed granularity tag
	 * (`symbol`/`codefile`/`subfolder`), pruned because
	 * `settings.pruneStaleFlowcharts` is on.
	 */
	prunedFiles: string[];
}

export interface NodeSpec {
	key: string;
	id: string;
	node: Record<string, any>; // JSONCanvas node; x/y filled in by layout
	width: number;
	height: number;
}

export interface EdgeSpec {
	fromKey: string;
	toKey: string;
	label?: string;
}

// ---------- tag-driven aggregation ----------

/** An edge endpoint outside the canvas that carries the tag: a target symbol in some file. */
export interface ExternalEdge {
	file: string;
	subpath: string;
	label?: string;
}

/**
 * What an aggregate canvas contributes to its parent's aggregation: which code
 * files its subtree covers, the descendant edges whose targets lie outside it,
 * and the union of all descendant edge tags (re-emitted as its own tags).
 */
export interface AggregateInfo {
	canvasPath: string;
	included: boolean;
	coveredFiles: Set<string>;
	externalEdges: ExternalEdge[];
	edgeTags: Set<string>;
}

/**
 * Lifts child external edges onto an aggregate canvas: an edge whose target
 * file is covered by a sibling child becomes an edge between the two child
 * nodes (only when both ends are included — an excluded endpoint isn't a node,
 * and the edge would only self-loop higher up, so it's dropped); an edge whose
 * target no child covers propagates upward as this canvas's own external edge.
 */
export function liftChildEdges(children: AggregateInfo[]): { edges: EdgeSpec[]; externalEdges: ExternalEdge[] } {
	const edges: EdgeSpec[] = [];
	const upward: ExternalEdge[] = [];
	const seen = new Set<string>();
	const seenUp = new Set<string>();
	for (const a of children) {
		for (const e of a.externalEdges) {
			const b = children.find((c) => c !== a && c.coveredFiles.has(e.file));
			if (!b) {
				const k = `${e.file}${e.subpath} ${e.label ?? ""}`;
				if (!seenUp.has(k)) {
					seenUp.add(k);
					upward.push(e);
				}
				continue;
			}
			if (!a.included || !b.included) continue;
			const dedupe = `${a.canvasPath}->${b.canvasPath}`;
			if (seen.has(dedupe)) continue;
			seen.add(dedupe);
			edges.push({ fromKey: `canvas:${a.canvasPath}`, toKey: `canvas:${b.canvasPath}`, label: e.label });
		}
	}
	return { edges, externalEdges: upward };
}

export function newCanvasId(): string {
	let s = "";
	for (let i = 0; i < 16; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
	return s;
}

/**
 * Deterministic 16-hex-char id for a seed string (two 32-bit FNV-1a passes,
 * the second seeded with the first). Node ids hash the node's stable key
 * (`file#name#occurrence`, `canvas:<path>`, `whole:<path>`), edge ids hash
 * `from->to#label`, so regenerating an unchanged tree rewrites identical
 * canvases and `writeCanvas` can carry node positions over by id.
 */
export function stableId(seed: string): string {
	const fnv = (basis: number): number => {
		let h = basis;
		for (let i = 0; i < seed.length; i++) {
			h ^= seed.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	};
	const hi = fnv(0x811c9dc5);
	const lo = fnv(hi ^ 0x811c9dc5);
	return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/** Max "_" prefixes tried when a generated canvas path collides within a run. */
const MAX_COLLISION_PREFIXES = 5;

/**
 * Claims a canvas path for the current run. On a collision (compared
 * lowercased, for case-insensitive filesystems) the file name gets a "_"
 * prefix and is retried, up to `MAX_COLLISION_PREFIXES` prefixes (`_x.canvas`,
 * `__x.canvas`, …). Returns null when the path is still taken after that.
 */
function claimCanvasPath(claimed: Set<string>, desired: string): string | null {
	let path = desired;
	for (let i = 0; ; i++) {
		const key = path.toLowerCase();
		if (!claimed.has(key)) {
			claimed.add(key);
			return path;
		}
		if (i >= MAX_COLLISION_PREFIXES) return null;
		const slash = path.lastIndexOf("/");
		path = `${path.slice(0, slash + 1)}_${path.slice(slash + 1)}`;
	}
}

function fnKey(file: TFile, fnName: string, occurrence = 1): string {
	return `${file.path}#${fnName}#${occurrence}`;
}

function subpathFor(symbol: SymbolInfo): string {
	return symbol.occurrence > 1 ? `#${symbol.name}#${symbol.occurrence}` : `#${symbol.name}`;
}

// ---------- sub-flowchart generation ----------

export async function generateFlowcharts(
	plugin: CodeFilesPlugin,
	model: FlowchartModel,
): Promise<GenerateResult> {
	const app = plugin.app;
	const root = model.root;
	const outBase = root.path === "/" ? "flowcharts" : `${root.path}/flowcharts`;
	const nodeW = plugin.settings.canvasNodeWidth;
	const nodeH = plugin.settings.canvasNodeHeight;

	let canvasCount = 0;
	let nodeCount = 0;
	let edgeCount = 0;
	const renamedFiles: string[] = [];
	const skipped: string[] = [];

	// Canvases already on disk under the generated tree, for stale reporting /
	// pruning (a naming-scheme change orphans the old names).
	const subflowchartsDir = app.vault.getAbstractFileByPath(`${outBase}/Subflowcharts`);
	const preExisting: string[] =
		subflowchartsDir instanceof TFolder ? collectCanvasFiles(subflowchartsDir).map((f) => f.path) : [];
	const writtenPaths = new Set<string>(); // lowercased

	// Paths claimed this run (lowercased — the filesystem may be
	// case-insensitive even though the vault's path lookup isn't). Referencing
	// canvases (file canvas → declaration canvases, folder canvas → file/folder
	// canvases) must point at the paths actually written, so the claimed path
	// of every written canvas is remembered (via declInfos / fileAggInfos /
	// the folder recursion's AggregateInfo).
	const claimed = new Set<string>();

	// Pre-claim every canvas path in the exact order the write loop below
	// claims them (per file: declaration canvases in symbol order, then the
	// file canvas; then folder canvases in post-order DFS), so aggregate-chain
	// tags can name the paths actually written — "_" collision prefixes
	// included — before any canvas exists.
	const preclaimed = new Map<string, string>(); // desired path → claimed path
	const fileCanvasPathByFile = new Map<string, string>();
	const folderCanvasPathByFolderPath = new Map<string, string>();
	const declNameMaps = new Map<string, DeclNameMap>();
	const folderTree = buildFolderTree(root, model.files);
	const preclaim = (desired: string): string | null => {
		const p = claimCanvasPath(claimed, desired);
		if (p) preclaimed.set(desired, p);
		return p;
	};
	for (const ff of model.files) {
		const names = buildDeclNameMap(ff.symbols, ff.file.basename);
		declNameMaps.set(ff.file.path, names);
		for (const sym of ff.symbols) preclaim(declCanvasPathFor(outBase, root, ff.file, sym, names).path);
		const p = preclaim(fileCanvasPathFor(outBase, root, ff.file));
		if (p) fileCanvasPathByFile.set(ff.file.path, p);
	}
	const preclaimFolders = (node: FolderTreeNode): void => {
		for (const [, sub] of node.subfolders) preclaimFolders(sub);
		const desired = folderCanvasPathFor(outBase, root, node.folder);
		if (desired) {
			const p = preclaim(desired);
			if (p) folderCanvasPathByFolderPath.set(node.folder.path, p);
		}
	};
	if (folderTree) preclaimFolders(folderTree);

	/**
	 * Aggregate-chain tags for an edge target: the claimed codefile canvas
	 * containing the target file plus every claimed ancestor subfolder canvas
	 * up to (and including) the root canvas. Empty for targets outside the
	 * generated tree.
	 */
	const aggregateChainTagsFor = (targetFile: string, label?: string): string[] => {
		const codefile = fileCanvasPathByFile.get(targetFile);
		if (!codefile) return [];
		const tags = [edgeTagFor(codefile, "", label)];
		const tf = app.vault.getAbstractFileByPath(targetFile);
		let dir = tf?.parent ?? null;
		while (dir) {
			const p = folderCanvasPathByFolderPath.get(dir.path);
			if (p) tags.push(edgeTagFor(p, "", label));
			if (dir.path === root.path) break;
			dir = dir.parent;
		}
		return tags;
	};

	/** Drops chain tags that would name the canvas being written. */
	const withoutSelfTags = (ownPath: string, tags: string[]): string[] =>
		tags.filter((t) => parseEdgeTag(t)?.file !== ownPath);

	/** Claims `desired` (pre-claimed above, or a "_" prefixed variant) and writes the canvas there. */
	const writeClaimed = async (
		desired: string,
		data: { nodes: any[]; edges: any[] },
		opts: WriteCanvasOptions = {},
	): Promise<{ path: string; included: boolean } | null> => {
		const path = preclaimed.get(desired) ?? claimCanvasPath(claimed, desired);
		if (!path) {
			skipped.push(desired);
			return null;
		}
		if (path !== desired) renamedFiles.push(path);
		const { included } = await writeCanvas(app, path, data, opts);
		writtenPaths.add(path.toLowerCase());
		canvasCount++;
		nodeCount += data.nodes.length;
		edgeCount += data.edges.length;
		return { path, included };
	};

	// ---------- per-declaration + per-file canvases ----------

	/** fnKey → the decl canvas's written path, inclusion, and outgoing edge targets. */
	const declInfos = new Map<string, { path: string; included: boolean; targets: ExternalEdge[] }>();
	/** file.path → the file canvas's aggregate info, for the folder level. */
	const fileAggInfos = new Map<string, AggregateInfo>();

	for (const ff of model.files) {
		const folder = fileFolderFor(outBase, root, ff.file);
		if (folder.renamed) renamedFiles.push(`${folder.path}/`);
		const declNames = declNameMaps.get(ff.file.path) ?? buildDeclNameMap(ff.symbols, ff.file.basename);

		// Per-symbol outgoing edge targets. Every detected edge is a
		// symbol→symbol / symbol→reducer / symbol→table edge, so they all
		// become edge tags on the declaration canvases.
		const symbolByName = new Map<string, SymbolInfo>();
		for (const s of ff.symbols) {
			if (!symbolByName.has(s.name)) symbolByName.set(s.name, s);
		}
		const targetsBySym = new Map<string, ExternalEdge[]>(); // fnKey → targets
		const addTarget = (fromSym: SymbolInfo, tgt: ExternalEdge) => {
			const fromKey = fnKey(ff.file, fromSym.name, fromSym.occurrence);
			const list = targetsBySym.get(fromKey) ?? [];
			if (!list.some((t) => t.file === tgt.file && t.subpath === tgt.subpath && t.label === tgt.label)) {
				list.push(tgt);
			}
			targetsBySym.set(fromKey, list);
		};
		for (const e of ff.detectedEdges) {
			let target: ExternalEdge | null = null;
			if (e.to.startsWith("reducer:")) {
				const t = model.reducerIndex.get(e.to.slice("reducer:".length));
				if (t) target = { file: t.file.path, subpath: `#${t.fnName}`, label: e.label };
			} else if (e.to.startsWith("table:")) {
				const t = model.accessorIndex.get(toSnakeCase(e.to.slice("table:".length)));
				if (t) target = { file: t.ff.file.path, subpath: subpathFor(t.sym), label: e.label };
			} else {
				const sym =
					e.toOccurrence !== undefined
						? (ff.symbols.find((s) => s.name === e.to && s.occurrence === e.toOccurrence) ??
							symbolByName.get(e.to)!)
						: symbolByName.get(e.to)!;
				target = { file: ff.file.path, subpath: subpathFor(sym), label: e.label };
			}
			if (!target) continue;
			addTarget(symbolByName.get(e.from)!, target);
		}
		// Cross-file rs references resolve to an already-resolved file + symbol.
		for (const e of ff.crossDetectedEdges) {
			const fromSym =
				e.fromOccurrence !== undefined
					? (ff.symbols.find((s) => s.name === e.from && s.occurrence === e.fromOccurrence) ??
						symbolByName.get(e.from))
					: symbolByName.get(e.from);
			if (!fromSym) continue;
			addTarget(fromSym, { file: e.toFile.path, subpath: subpathFor(e.toSym), label: e.label });
		}

		// One declaration canvas per symbol: a single narrowed symbol node, with
		// its outgoing edges recorded as tags (code target + aggregate chain).
		for (const sym of ff.symbols) {
			const decl = declCanvasPathFor(outBase, root, ff.file, sym, declNames);
			if (decl.renamed) renamedFiles.push(decl.path);
			const targets = targetsBySym.get(fnKey(ff.file, sym.name, sym.occurrence)) ?? [];
			const tagSet = new Set<string>();
			for (const t of targets) {
				tagSet.add(edgeTagFor(t.file, t.subpath, t.label));
				for (const c of aggregateChainTagsFor(t.file, t.label)) tagSet.add(c);
			}
			const tags = [TAG_SYMBOL, ...tagSet];
			const data = buildCanvasData([symbolNodeSpec(ff, sym, nodeW, nodeH)], [], plugin);
			const written = await writeClaimed(decl.path, data, { tags, autoInclude: true });
			if (written) {
				declInfos.set(fnKey(ff.file, sym.name, sym.occurrence), { ...written, targets });
			}
		}

		// The file canvas aggregates the included declaration canvases. A
		// symbol-less file gets a single whole-file node instead.
		const specs: NodeSpec[] = [];
		const declKeyBySubpath = new Map<string, string>(); // subpath → spec key
		if (ff.symbols.length === 0) {
			specs.push(wholeFileNodeSpec(ff, nodeW, nodeH));
		} else {
			for (const sym of ff.symbols) {
				const key = fnKey(ff.file, sym.name, sym.occurrence);
				const info = declInfos.get(key);
				if (!info || !info.included) continue;
				specs.push(declRefNodeSpec(ff, sym, info.path, nodeW, nodeH));
				declKeyBySubpath.set(subpathFor(sym), key);
			}
		}

		// Edges come from the symbol canvases' tags: a tag whose target lives in
		// this file (and is an included node here) becomes an edge; anything else
		// is an external edge for the folder level to lift.
		const edges: EdgeSpec[] = [];
		const seen = new Set<string>();
		const external: ExternalEdge[] = [];
		for (const sym of ff.symbols) {
			const key = fnKey(ff.file, sym.name, sym.occurrence);
			const info = declInfos.get(key);
			if (!info) continue;
			for (const t of info.targets) {
				const toKey = t.file === ff.file.path && info.included ? declKeyBySubpath.get(t.subpath) : undefined;
				if (!toKey || toKey === key) {
					if (toKey !== key && !external.some((x) => x.file === t.file && x.subpath === t.subpath && x.label === t.label)) {
						external.push(t);
					}
					continue;
				}
				const dedupe = `${key}->${toKey}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);
				edges.push({ fromKey: key, toKey, label: t.label });
			}
		}

		// File-owned edges (`.tscn` wiring): tags on this canvas, and external
		// so folder canvases lift them onto sibling nodes.
		for (const fe of ff.fileEdges) {
			const t: ExternalEdge = { file: fe.toFile.path, subpath: fe.toSym ? subpathFor(fe.toSym) : "", label: fe.label };
			if (!external.some((x) => x.file === t.file && x.subpath === t.subpath && x.label === t.label)) {
				external.push(t);
			}
		}

		const childTags = new Set<string>();
		for (const sym of ff.symbols) {
			for (const t of targetsBySym.get(fnKey(ff.file, sym.name, sym.occurrence)) ?? []) {
				childTags.add(edgeTagFor(t.file, t.subpath, t.label));
				for (const c of aggregateChainTagsFor(t.file, t.label)) childTags.add(c);
			}
		}
		for (const fe of ff.fileEdges) {
			childTags.add(edgeTagFor(fe.toFile.path, fe.toSym ? subpathFor(fe.toSym) : "", fe.label));
			for (const c of aggregateChainTagsFor(fe.toFile.path, fe.label)) childTags.add(c);
		}
		const data = buildCanvasData(specs, edges, plugin);
		const fileCanvasDesired = fileCanvasPathFor(outBase, root, ff.file);
		const ownCanvasPath = preclaimed.get(fileCanvasDesired) ?? fileCanvasDesired;
		const written = await writeClaimed(fileCanvasDesired, data, {
			tags: [TAG_CODEFILE, ...withoutSelfTags(ownCanvasPath, [...childTags])],
			autoInclude: true,
		});
		if (written) {
			fileAggInfos.set(ff.file.path, {
				canvasPath: written.path,
				included: written.included,
				coveredFiles: new Set([ff.file.path]),
				externalEdges: external,
				edgeTags: childTags,
			});
		}
	}

	// ---------- per-folder canvases (sub-flowchart nodes, lifted edges) ----------
	// (folderTree was already built — and every folder canvas path pre-claimed —
	// ahead of the per-file loop, so chain tags could reference folder canvases.)

	const emitFolderCanvas = async (node: FolderTreeNode): Promise<AggregateInfo | null> => {
		// Children first, so their aggregate info is known.
		const children: AggregateInfo[] = [];
		for (const f of node.files) {
			const info = fileAggInfos.get(f.path);
			if (info) children.push(info);
		}
		for (const [, sub] of node.subfolders) {
			const info = await emitFolderCanvas(sub);
			if (info) children.push(info);
		}

		const specs = children
			.filter((c) => c.included)
			.map((c) => subflowchartNodeSpec(c.canvasPath, nodeW, nodeH));
		const { edges, externalEdges } = liftChildEdges(children);
		const edgeTags = new Set<string>();
		const coveredFiles = new Set<string>();
		for (const c of children) {
			for (const t of c.edgeTags) edgeTags.add(t);
			for (const f of c.coveredFiles) coveredFiles.add(f);
		}

		const data = buildCanvasData(specs, edges, plugin);
		const desired = folderCanvasPathFor(outBase, root, node.folder)!;
		const written = await writeClaimed(desired, data, {
			tags: [TAG_SUBFOLDER, ...withoutSelfTags(preclaimed.get(desired) ?? desired, [...edgeTags])],
			autoInclude: true,
		});
		if (!written) return null;
		return { canvasPath: written.path, included: written.included, coveredFiles, externalEdges, edgeTags };
	};
	if (folderTree) await emitFolderCanvas(folderTree);

	// Stale canvases (present before the run, not written by it) carrying a
	// managed granularity tag are safe to prune — they are regenerated
	// artifacts, not user canvases — when the setting allows it.
	const stale: string[] = [];
	const prunedFiles: string[] = [];
	for (const p of preExisting.filter((p) => !writtenPaths.has(p.toLowerCase())).sort()) {
		const file = app.vault.getAbstractFileByPath(p);
		if (plugin.settings.pruneStaleFlowcharts && file instanceof TFile) {
			const tags = await readCanvasTags(app, file);
			if (tags.includes(TAG_SYMBOL) || tags.includes(TAG_CODEFILE) || tags.includes(TAG_SUBFOLDER)) {
				await app.vault.trash(file, plugin.settings.pruneToSystemTrash);
				prunedFiles.push(p);
				continue;
			}
		}
		stale.push(p);
	}
	return {
		outBase,
		fileCount: model.files.length,
		canvasCount,
		nodeCount,
		edgeCount,
		renamedFiles,
		skipped,
		staleFiles: stale,
		prunedFiles,
	};
}

// ---------- include flags (canvas metadata) ----------

/** All tags on a canvas's `metadata.frontmatter.tags` (empty on any failure). */
export async function readCanvasTags(app: App, file: TFile): Promise<string[]> {
	try {
		const tags = JSON.parse(await app.vault.read(file))?.metadata?.frontmatter?.tags;
		if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === "string");
		if (typeof tags === "string") return [tags];
	} catch {
		// fall through
	}
	return [];
}

/**
 * Include flags live as tags (`frontmatter.tags: ["includeInMainFlowchart"]`,
 * `["includeInAggregateFlowchart"]`), not standalone boolean properties, so
 * they show up alongside any other tags a user adds to a canvas and behave
 * like normal Obsidian tags elsewhere (search, tag pane, etc).
 */
export async function readTagFlag(app: App, file: TFile, tag: string): Promise<boolean> {
	return (await readCanvasTags(app, file)).includes(tag);
}

export async function setTagFlag(app: App, file: TFile, tag: string, on: boolean): Promise<void> {
	let data: any;
	try {
		data = JSON.parse(await app.vault.read(file));
	} catch {
		data = { nodes: [], edges: [] };
	}
	if (!data.metadata || typeof data.metadata !== "object") data.metadata = {};
	if (!data.metadata.frontmatter || typeof data.metadata.frontmatter !== "object") {
		data.metadata.frontmatter = {};
	}
	const fm = data.metadata.frontmatter;
	const otherTags: string[] = Array.isArray(fm.tags)
		? fm.tags.filter((t: unknown) => typeof t === "string" && t !== tag)
		: [];
	if (on) {
		fm.tags = [...otherTags, tag];
	} else if (otherTags.length > 0) {
		fm.tags = otherTags;
	} else {
		delete fm.tags;
	}
	await app.vault.modify(file, JSON.stringify(data, null, "\t"));
}

export async function readIncludeFlag(app: App, file: TFile): Promise<boolean> {
	return readTagFlag(app, file, INCLUDE_FLAG);
}

export async function setIncludeFlag(app: App, file: TFile, include: boolean): Promise<void> {
	return setTagFlag(app, file, INCLUDE_FLAG, include);
}

/** True for generated sub-flowchart canvases (…/flowcharts/Subflowcharts/….canvas). */
export function isGeneratedSubflowchartPath(path: string): boolean {
	return path.endsWith(".canvas") && /(^|\/)flowcharts\/Subflowcharts\//.test(path);
}

/** All `.canvas` files under `folder` (any depth), sorted by path. */
export function collectCanvasFiles(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (dir: TFolder) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === "canvas") out.push(child);
		}
	};
	walk(folder);
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

/**
 * `.canvas` files under `folder`, but only down to `maxDepth` levels of
 * subfolders. `folder` itself is depth 0 (its direct file children always
 * qualify); each nested subfolder adds one to the depth of the files inside
 * it. `maxDepth <= 0` behaves like "this folder's own canvases only".
 */
export function collectCanvasFilesUpToDepth(folder: TFolder, maxDepth: number): TFile[] {
	const out: TFile[] = [];
	const walk = (dir: TFolder, depth: number) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) {
				if (depth < maxDepth) walk(child, depth + 1);
			} else if (child instanceof TFile && child.extension === "canvas") {
				out.push(child);
			}
		}
	};
	walk(folder, 0);
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

// ---------- node / edge construction ----------

function symbolNodeSpec(ff: FlowchartFile, sym: SymbolInfo, w: number, h: number): NodeSpec {
	const key = fnKey(ff.file, sym.name, sym.occurrence);
	const node: Record<string, any> = {
		id: "",
		type: "file",
		file: ff.file.path,
		subpath: subpathFor(sym),
	};
	if (ff.reducerFns.has(sym.name)) node.color = COLOR_REDUCER;
	return {
		key,
		id: stableId(key),
		node,
		width: w,
		height: h,
	};
}

export function subflowchartNodeSpec(canvasPath: string, w: number, h: number): NodeSpec {
	const key = `canvas:${canvasPath}`;
	return {
		key,
		id: stableId(key),
		node: { id: "", type: "file", file: canvasPath, color: COLOR_SUBFLOWCHART },
		width: w,
		height: h,
	};
}

/**
 * Reference to a declaration canvas from inside the aggregating file canvas.
 * Keyed like a symbol node (`<file>#<name>#<occurrence>`) so the tag-driven
 * edge assembly resolves onto these nodes unchanged.
 */
function declRefNodeSpec(ff: FlowchartFile, sym: SymbolInfo, canvasPath: string, w: number, h: number): NodeSpec {
	const key = fnKey(ff.file, sym.name, sym.occurrence);
	return {
		key,
		id: stableId(key),
		node: { id: "", type: "file", file: canvasPath, color: COLOR_SUBFLOWCHART },
		width: w,
		height: h,
	};
}

/** Whole-file node for the file canvas of a file with no linkable symbols. */
function wholeFileNodeSpec(ff: FlowchartFile, w: number, h: number): NodeSpec {
	const key = `whole:${ff.file.path}`;
	return {
		key,
		id: stableId(key),
		node: { id: "", type: "file", file: ff.file.path },
		width: w,
		height: h,
	};
}

// ---------- layout + canvas JSON ----------

export function buildCanvasData(
	specs: NodeSpec[],
	edges: EdgeSpec[],
	plugin: CodeFilesPlugin,
): { nodes: any[]; edges: any[] } {
	const idByKey = new Map(specs.map((s) => [s.key, s.id]));
	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: "TB",
		nodesep: plugin.settings.flowchartNodeSpacingX,
		ranksep: plugin.settings.flowchartNodeSpacingY,
		marginx: 0,
		marginy: 0,
	});
	g.setDefaultEdgeLabel(() => ({}));
	for (const s of specs) g.setNode(s.id, { width: s.width, height: s.height });
	for (const e of edges) {
		const from = idByKey.get(e.fromKey);
		const to = idByKey.get(e.toKey);
		if (from && to) g.setEdge(from, to);
	}
	dagre.layout(g);

	const nodes: any[] = [];
	for (const s of specs) {
		const pos = g.node(s.id);
		s.node.id = s.id;
		s.node.x = Math.round(pos.x - s.width / 2);
		s.node.y = Math.round(pos.y - s.height / 2);
		s.node.width = s.width;
		s.node.height = s.height;
		nodes.push(s.node);
	}

	const canvasEdges: any[] = [];
	for (const e of edges) {
		const from = idByKey.get(e.fromKey);
		const to = idByKey.get(e.toKey);
		if (!from || !to) continue;
		const edge: Record<string, any> = {
			id: stableId(`${from}->${to}#${e.label ?? ""}`),
			fromNode: from,
			fromSide: "bottom",
			toNode: to,
			toSide: "top",
			toEnd: "arrow",
		};
		if (e.label) edge.label = e.label;
		canvasEdges.push(edge);
	}

	return { nodes, edges: canvasEdges };
}

export interface WriteCanvasOptions {
	/**
	 * Managed tags to stamp (granularity + edge tags). On overwrite they replace
	 * the existing managed tags while user tags (include flags, anything else)
	 * are preserved; on create they become the canvas's tags.
	 */
	tags?: string[];
	/**
	 * Stamp `AGGREGATE_INCLUDE_FLAG` when creating the canvas (or overwriting a
	 * legacy canvas that carries no managed tags yet). Otherwise never re-added
	 * on overwrite — an absent flag there is the user's explicit Exclude.
	 */
	autoInclude?: boolean;
}

export interface WriteCanvasResult {
	/** Whether the written canvas carries `AGGREGATE_INCLUDE_FLAG`. */
	included: boolean;
}

/**
 * Case-insensitive canvas lookup. The vault's path lookup is case-sensitive but
 * the filesystem may not be: fall back to a case-insensitive match so create()
 * doesn't fail with "File already exists" for a path that only differs in case.
 */
export function findCanvasFile(app: App, path: string): TFile | null {
	const direct = app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFile) return direct;
	const parent = path.split("/").slice(0, -1).join("/");
	const dir = app.vault.getAbstractFileByPath(parent);
	if (dir instanceof TFolder) {
		const hit = dir.children.find(
			(c) => c instanceof TFile && c.path.toLowerCase() === path.toLowerCase(),
		);
		if (hit instanceof TFile) return hit;
	}
	return null;
}

function tagsOf(metadata: any): string[] {
	const tags = metadata?.frontmatter?.tags;
	if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === "string");
	if (typeof tags === "string") return [tags];
	return [];
}

/**
 * Creates or overwrites a canvas file. On overwrite the existing `metadata`
 * object (frontmatter) is carried over, with managed tags (granularity +
 * `edge-` tags) refreshed and all other tags — including the include flags —
 * preserved, so regeneration never resets the user's include choices or custom
 * tags. On create, `opts.tags` plus (with `autoInclude`) the aggregate include
 * flag become the canvas's tags.
 *
 * On overwrite the existing nodes' geometry is carried over too: a node in
 * `data` whose id matches an existing node keeps that node's x/y/width/height
 * (node ids are deterministic — see `stableId`), so user-dragged layouts
 * survive regeneration. New nodes keep their dagre positions.
 */
export async function writeCanvas(
	app: App,
	path: string,
	data: { nodes: any[]; edges: any[] },
	opts: WriteCanvasOptions = {},
): Promise<WriteCanvasResult> {
	const parent = path.split("/").slice(0, -1).join("/");
	await ensureFolderPath(app, parent);
	const existing = findCanvasFile(app, path);
	const managed = opts.tags ?? [];
	if (existing) {
		let existingData: any;
		try {
			existingData = JSON.parse(await app.vault.cachedRead(existing));
		} catch {
			existingData = undefined;
		}
		let metadata: any = existingData?.metadata;
		// Carry each existing node's geometry onto the regenerated node with
		// the same id (position preservation — see the doc comment above).
		if (existingData && Array.isArray(existingData.nodes)) {
			const geometryById = new Map<string, { x: number; y: number; width: number; height: number }>();
			for (const n of existingData.nodes) {
				if (typeof n?.id === "string") {
					geometryById.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height });
				}
			}
			for (const n of data.nodes) {
				const geo = geometryById.get(n?.id);
				if (geo) Object.assign(n, geo);
			}
		}
		let included = false;
		if (managed.length > 0) {
			const existingTags = tagsOf(metadata);
			// A canvas with no managed tags yet predates the tag system — treat
			// it like a fresh create so autoInclude applies; afterwards an absent
			// flag is respected as the user's explicit Exclude.
			const legacy = !existingTags.some(isManagedTag);
			const userTags = existingTags.filter((t) => !isManagedTag(t));
			if (legacy && opts.autoInclude && !userTags.includes(AGGREGATE_INCLUDE_FLAG)) {
				userTags.push(AGGREGATE_INCLUDE_FLAG);
			}
			included = userTags.includes(AGGREGATE_INCLUDE_FLAG);
			if (!metadata || typeof metadata !== "object") metadata = {};
			if (!metadata.frontmatter || typeof metadata.frontmatter !== "object") {
				metadata.frontmatter = {};
			}
			metadata.frontmatter.tags = [...new Set([...userTags, ...managed])];
		}
		const out = metadata && typeof metadata === "object" ? { ...data, metadata } : data;
		await app.vault.modify(existing, JSON.stringify(out, null, "\t"));
		return { included };
	}
	const tags = [...new Set([...managed, ...(opts.autoInclude ? [AGGREGATE_INCLUDE_FLAG] : [])])];
	const out = tags.length > 0 ? { ...data, metadata: { frontmatter: { tags } } } : data;
	await app.vault.create(path, JSON.stringify(out, null, "\t"));
	return { included: opts.autoInclude ?? false };
}

async function ensureFolderPath(app: App, path: string): Promise<void> {
	if (!path) return;
	const segs = path.split("/");
	let current = "";
	for (const seg of segs) {
		current = current ? `${current}/${seg}` : seg;
		if (!app.vault.getAbstractFileByPath(current)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// Tolerate "already exists" — e.g. a case-only variant of the
				// folder is already on disk (case-insensitive filesystem); the
				// canvases simply merge into it.
			}
		}
	}
}

// ---------- path / tree helpers ----------

function rootName(root: TFolder): string {
	return root.name || "root";
}

function relativeDir(rootPath: string, item: TFile | TFolder): string {
	const parent = item.parent?.path ?? "";
	// Vault-root generation: the root folder's own path is "/", and items
	// directly under it have "" as their relative dir (a literal "/" parent
	// would split into empty segments and produce junk `_subfolder` dirs).
	if (rootPath === "/") return parent === "/" ? "" : parent;
	if (parent === rootPath) return "";
	return parent.startsWith(rootPath + "/") ? parent.slice(rootPath.length + 1) : parent;
}

/**
 * The mirrored directory an item's generated output lives under, relative to
 * `Subflowcharts/`. Every segment mirrors a *vault folder*, so each carries the
 * `_subfolder` granularity suffix (`Movement/Sub` → `Movement_subfolder/Sub_subfolder`).
 * Empty for items directly under the code root (`Subflowcharts/` is root's own
 * mirrored directory).
 */
function mirroredDir(rootPath: string, item: TFile | TFolder): string {
	const rel = relativeDir(rootPath, item);
	if (!rel) return "";
	return rel
		.split("/")
		.map((seg) => `${seg}${SUFFIX_SUBFOLDER}`)
		.join("/");
}

/**
 * Subflowcharts/<subpath>/<File>_codefile — the per-file folder holding the
 * file's own canvas plus one canvas per declaration. A file whose basename
 * matches a *sibling subfolder* (`Movement/move.cs` next to `Movement/move/`)
 * keeps a "File" suffix on its folder (`moveFile_codefile/`) so names stay
 * stable from before the granularity suffixes existed — `_codefile` vs
 * `_subfolder` already keeps the two mirrored directories apart.
 */
function fileFolderFor(outBase: string, root: TFolder, file: TFile): { path: string; renamed: boolean } {
	const relDir = mirroredDir(root.path, file);
	// Case-insensitive: `Move.cs` next to a `move/` folder collides on disk
	// even though the names differ in case.
	const siblingClash = file.parent?.children.some(
		(c) => c instanceof TFolder && c.name.toLowerCase() === file.basename.toLowerCase(),
	);
	const name = `${siblingClash ? `${file.basename}File` : file.basename}${SUFFIX_CODEFILE}`;
	return {
		path: normalizePath(`${outBase}/Subflowcharts/${relDir ? relDir + "/" : ""}${name}`),
		renamed: !!siblingClash,
	};
}

/**
 * Subflowcharts/<subpath>/<File>_codefile/<File>_codefile.canvas — the file's
 * own canvas, inside its per-file folder (see `fileFolderFor`). Carries only
 * the granularity suffix; never collision-suffixed.
 */
function fileCanvasPathFor(outBase: string, root: TFolder, file: TFile): string {
	return normalizePath(
		`${fileFolderFor(outBase, root, file).path}/${file.basename}${SUFFIX_CODEFILE}.canvas`,
	);
}

// ---------- declaration naming ----------

/** Key into a DeclNameMap for a symbol (`<name>#<occurrence>`). */
function declKey(sym: SymbolInfo): string {
	return `${sym.name}#${sym.occurrence}`;
}

/** Display names (no folder, no extension) for every declaration in one file. */
type DeclNameMap = Map<string, { name: string; renamed: boolean }>;

/** Groups working pairs by current base name (lowercased); returns only the still-tied groups. */
function tiedPairs(pairs: [SymbolInfo, string][]): [SymbolInfo, string][][] {
	const byBase = new Map<string, [SymbolInfo, string][]>();
	for (const pair of pairs) {
		const l = pair[1].toLowerCase();
		const g = byBase.get(l);
		if (g) g.push(pair);
		else byBase.set(l, [pair]);
	}
	return [...byBase.values()].filter((g) => g.length > 1);
}

/**
 * Rung 2 — suffix tied pairs with their minimal distinguishing parameter
 * types (`Move (float)`; shared parameters are omitted). Mixed arities use
 * full parameter lists; non-function members contribute their kind as the
 * label (`Foo (struct)`). No-op when the rendered suffixes don't split the
 * group (rung 3 then applies).
 */
function applySignatureRung(tied: [SymbolInfo, string][]): void {
	const sigs = tied.map(([s]) => (s.kind === "function" ? s.paramTypes : [s.kind]));
	const arities = new Set(sigs.map((p) => p.length));
	let labels: string[][];
	if (arities.size > 1) {
		labels = sigs; // mixed arity: full parameter lists always split
	} else {
		const n = sigs[0].length;
		const picked: number[] = [];
		const distinct = () => {
			const seen = new Set<string>();
			for (const p of sigs) {
				const key = picked.map((i) => p[i]).join("").toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
			}
			return true;
		};
		for (let i = 0; i < n && !distinct(); i++) {
			if (new Set(sigs.map((p) => p[i].toLowerCase())).size > 1) picked.push(i);
		}
		if (!distinct()) return; // identical signatures — rung 3 handles it
		labels = sigs.map((p) => picked.map((i) => p[i]));
	}
	const rendered = labels.map((l) => (l.length > 0 ? l.join(", ") : "no params"));
	if (new Set(rendered.map((r) => r.toLowerCase())).size !== rendered.length) return;
	tied.forEach((pair, i) => {
		pair[1] = `${pair[1]} (${rendered[i]})`;
	});
}

/**
 * Rung 3 — genuinely identical duplicates (e.g. #[cfg] variants). The first
 * keeps the plain name (mirroring `#name` resolving to occurrence 1); the
 * rest get their occurrence number (`helper 2`; `#` is illegal in Obsidian
 * file names).
 */
function applyOccurrenceRung(tied: [SymbolInfo, string][]): void {
	for (let i = 1; i < tied.length; i++) {
		tied[i][1] = `${tied[i][1]} ${tied[i][0].occurrence}`;
	}
}

/**
 * Computes the display name (no folder, no extension) for every declaration
 * in a file. Non-colliding symbols keep the plain name. Same-name groups go
 * through a three-rung ladder:
 *  1. container qualification (`MapConfig.seed`) — only when the group's
 *     enclosing scopes actually differ, so same-class overloads don't carry
 *     a redundant class prefix;
 *  2. minimal distinguishing parameter types (`Move (float)`);
 *  3. occurrence number (`helper 2`) for identical duplicates.
 * Afterwards: a name equal to its file's basename gets the " (kind)" suffix
 * (case-insensitive), and cross-group case-only clashes (trait `Seed` next
 * to fn `seed`) get a container qualifier where one is available — anything
 * still tied falls through to claimCanvasPath's "_" prefixes.
 */
function buildDeclNameMap(symbols: SymbolInfo[], fileBasename: string): DeclNameMap {
	const byName = new Map<string, SymbolInfo[]>();
	for (const s of symbols) {
		const g = byName.get(s.name);
		if (g) g.push(s);
		else byName.set(s.name, [s]);
	}

	const base = new Map<SymbolInfo, string>();
	for (const [name, group] of byName) {
		if (group.length === 1) {
			base.set(group[0], name);
			continue;
		}
		const pairs = group.map((s): [SymbolInfo, string] => [s, name]);
		// Rung 1 — container qualification, but only when the group's scopes
		// actually differ (same-class overloads go straight to rung 2 rather
		// than carrying a redundant class prefix).
		const containers = new Set(group.map((s) => (s.container ?? "").toLowerCase()));
		if (containers.size > 1) {
			for (const pair of pairs) {
				if (pair[0].container) pair[1] = `${pair[0].container}.${name}`;
			}
		}
		for (const tied of tiedPairs(pairs)) applySignatureRung(tied);
		for (const tied of tiedPairs(pairs)) applyOccurrenceRung(tied);
		for (const [s, b] of pairs) base.set(s, b);
	}

	const out: DeclNameMap = new Map();
	for (const s of symbols) {
		let name = base.get(s)!;
		let renamed = name !== s.name;
		// Case-insensitive: `Client.canvas` and `client.canvas` are the same
		// file on a case-insensitive filesystem.
		if (name.toLowerCase() === fileBasename.toLowerCase()) {
			name = `${name} (${s.kind})`;
			renamed = true;
		}
		out.set(declKey(s), { name, renamed });
	}

	// Cross-group case-only clashes (e.g. trait `Seed` next to a lone fn
	// `seed` — different name groups, same file name on a case-insensitive
	// filesystem): qualify with the container when that splits them.
	const byLower = new Map<string, SymbolInfo[]>();
	for (const s of symbols) {
		const l = out.get(declKey(s))!.name.toLowerCase();
		const g = byLower.get(l);
		if (g) g.push(s);
		else byLower.set(l, [s]);
	}
	for (const clash of byLower.values()) {
		if (clash.length < 2) continue;
		const taken = new Set([...out.values()].map((v) => v.name.toLowerCase()));
		for (const s of clash) taken.delete(out.get(declKey(s))!.name.toLowerCase());
		const trial = clash.map((s) => {
			const cur = out.get(declKey(s))!.name;
			return s.container && !cur.toLowerCase().startsWith(`${s.container.toLowerCase()}.`)
				? `${s.container}.${cur}`
				: cur;
		});
		const splits =
			new Set(trial.map((t) => t.toLowerCase())).size === trial.length &&
			trial.every((t) => !taken.has(t.toLowerCase()));
		if (!splits) continue; // claimCanvasPath's "_" prefixes take over
		clash.forEach((s, i) => out.set(declKey(s), { name: trial[i], renamed: true }));
	}
	return out;
}

/**
 * Subflowcharts/<subpath>/<File>_codefile/<symbol>_symbol.canvas — one canvas
 * per declaration. The display name comes from `buildDeclNameMap` (same-name
 * ladder + " (kind)" basename suffix), with the `_symbol` granularity suffix
 * appended last.
 */
function declCanvasPathFor(
	outBase: string,
	root: TFolder,
	file: TFile,
	symbol: SymbolInfo,
	names: DeclNameMap,
): { path: string; renamed: boolean } {
	const entry = names.get(declKey(symbol)) ?? { name: symbol.name, renamed: false };
	return {
		path: normalizePath(
			`${fileFolderFor(outBase, root, file).path}/${entry.name}${SUFFIX_SYMBOL}.canvas`,
		),
		renamed: entry.renamed,
	};
}

/**
 * Subflowcharts/<subpath>/<Folder>_subfolder/<Folder>_subfolder.canvas — a
 * folder's own canvas always lives inside its own mirrored directory, next to
 * its contents (see `fileFolderFor` for how a same-named sibling *file*'s
 * folder avoids colliding with it). The root folder is the one exception,
 * sitting at the top of the tree as Subflowcharts/<rootName>_subfolder.canvas
 * (Subflowcharts/ already *is* root's mirrored directory, so there's nothing
 * further to nest inside).
 */
function folderCanvasPathFor(outBase: string, root: TFolder, folder: TFolder): string | null {
	if (folder.path === root.path) {
		return normalizePath(`${outBase}/Subflowcharts/${rootName(root)}${SUFFIX_SUBFOLDER}.canvas`);
	}
	// Defensive: bail if folder isn't actually under root.
	let cur: TFolder | null = folder;
	while (cur && cur.path !== root.path) cur = cur.parent;
	if (!cur) return null;

	const relDir = mirroredDir(root.path, folder); // parent's mirrored path
	const ownName = `${folder.name}${SUFFIX_SUBFOLDER}`;
	const ownDir = relDir ? `${relDir}/${ownName}` : ownName;
	return normalizePath(`${outBase}/Subflowcharts/${ownDir}/${ownName}.canvas`);
}

interface FolderTreeNode {
	name: string;
	folder: TFolder;
	files: TFile[];
	subfolders: Map<string, FolderTreeNode>;
}

/** Folder tree limited to branches that contain at least one matched file. */
function buildFolderTree(root: TFolder, files: FlowchartFile[]): FolderTreeNode | null {
	const matched = new Set(files.map((f) => f.file.path));

	const walk = (folder: TFolder): FolderTreeNode | null => {
		const node: FolderTreeNode = { name: folder.name, folder, files: [], subfolders: new Map() };
		for (const child of folder.children) {
			if (child instanceof TFile) {
				if (matched.has(child.path)) node.files.push(child);
			} else if (child instanceof TFolder) {
				const sub = walk(child);
				if (sub) node.subfolders.set(child.name, sub);
			}
		}
		return node.files.length > 0 || node.subfolders.size > 0 ? node : null;
	};

	return walk(root);
}
