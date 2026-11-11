import { App, TFile, TFolder, normalizePath } from "obsidian";
import CodeFilesPlugin from "./main";
import {
	AGGREGATE_INCLUDE_FLAG,
	AggregateInfo,
	EDGE_TAG_PREFIX,
	EdgeSpec,
	ExternalEdge,
	NodeSpec,
	SUFFIX_CODEFILE,
	SUFFIX_SUBFOLDER,
	TAG_CODEFILE,
	TAG_SUBFOLDER,
	TAG_SYMBOL,
	buildCanvasData,
	collectCanvasFiles,
	edgeTagFor,
	liftChildEdges,
	newCanvasId,
	parseEdgeTag,
	readCanvasTags,
	subflowchartNodeSpec,
	writeCanvas,
} from "./flowchartCanvas";
import {
	flowCanvasFileName,
	flowMembers,
	isListFlow,
	migrateLegacyFlagsIfNeeded,
	readFlowsManifest,
} from "./flowchartFlows";
import {
	CodeIndex,
	ParsedCanvas,
	buildCodeIndex,
	globToRegExp,
	readTreeCanvases,
	symbolFileNode,
	symbolNameOf,
} from "./flowchartCodeLinks";
import { CodeSide, parseCodeSides, sideOf } from "./flowchartSides";
import {
	SubflowchartResolver,
	TimelineFlowResult,
	TimelineSpecError,
	composeTimelineFlow,
	isTimelineFlow,
} from "./flowchartTimeline";

/**
 * "Generate aggregate flowchart from subflowchart metadata" — the single
 * tag/structure-driven regeneration path. Per touched flowchart tree it:
 *
 * 1. Rebuilds the aggregate canvases (codefile + subfolder) from the edge
 *    tags on the symbol canvases, without touching the code or the code
 *    model. Leaves are rediscovered by their `symbol` tag, edges are
 *    re-derived from their `edge-…` tags, and each aggregate re-emits the
 *    union of its children's edge tags (see the flowchartCanvas module doc
 *    for the tag format). Aggregate-chain tags (edge tags whose target is a
 *    `.canvas` file) are NOT inherited from the leaves — they are re-derived
 *    structurally from each leaf's code targets against the current tree, so
 *    they can never go stale.
 * 2. Composes the tree's named flows (flows.json — see flowchartFlows.ts)
 *    into `<flowcharts>/main.canvas` (the default "main" flow) and
 *    `main-<name>.canvas` (any other flow). Nodes are the flow's listed
 *    canvases that still exist (missing paths are reported via
 *    `RegenerateResult.missingCanvases`; the manifest is left untouched).
 *    Edges come from the members' code-target edge tags: a tag on member
 *    canvas A resolves to the nearest OTHER member covering the target — the
 *    member symbol canvas whose file node matches `file`+`subpath` exactly,
 *    else the member codefile canvas whose dir covers the target file, else
 *    the nearest member ancestor subfolder canvas. Self-pairs drop, duplicate
 *    pairs collapse, labels carry over; chain tags (`.canvas` targets) are
 *    never drawn. No code model is built for this — the tags carry
 *    everything.
 *    A list flow written as an object with `"shared-links": true` also gets
 *    **shared-code links**: two members on different code sides (see
 *    flowchartSides.ts — e.g. a server system and a client crate) that both
 *    use symbols no member covers and that live on neither side (the shared
 *    `crates/`) get one dotted, arrowless `shares …` edge per pair — the
 *    connection a call graph hides, since neither member calls the other.
 *    `"shared-ignore": ["crates/kg_hex/**"]` drops ubiquitous helpers and
 *    `"shared-min": N` drops pairs sharing fewer than N symbols.
 *    **Timeline flows** (`"layout": "timeline"`) are laid out by
 *    flowchartTimeline.ts instead, with this tree's symbol canvases as the
 *    code index for their `code-links`.
 *
 * Tree structure is read off the directory layout, so collision renames
 * survive: a `<X>_codefile/` dir's canvas is its direct `.canvas` child tagged
 * `codefile` (falling back to name conventions), a `*_subfolder/` dir's canvas
 * likewise. Symbol-less files (a `*_codefile/` dir with no symbol leaves) keep
 * their existing canvas untouched but still participate as children. Text
 * nodes a user added to a rewritten aggregate are preserved verbatim, with
 * edges touching them re-attached to the regenerated file nodes.
 */

export interface RegenerateFlowResult {
	name: string;
	path: string;
	/** `list` (member canvases) or `timeline` (laid out by flowchartTimeline.ts). */
	kind: "list" | "timeline";
	/** List flows: member canvases drawn. Timeline flows: cards drawn. */
	included: number;
	edgeCount: number;
	/** List flows with `"shared-links"`: how many of the edges are shared-code links. */
	sharedEdgeCount?: number;
	/** Timeline flows: the full layout report (warnings, missing headings, code links). */
	timeline?: TimelineFlowResult;
}

export interface RegenerateResult {
	trees: number;
	written: number;
	edgeCount: number;
	flows: RegenerateFlowResult[];
	/** Flows that could not be composed (a timeline spec error), with the reason. */
	flowErrors: { name: string; error: string }[];
	/** Flow member paths listed in flows.json that no longer exist in the vault. */
	missingCanvases: string[];
	/**
	 * Composed `main-<name>.canvas` files whose flow no longer exists in
	 * flows.json (renamed/removed flow). Report-only — never deleted.
	 */
	orphanedFlowCanvases: string[];
}

interface LeafInfo {
	canvasPath: string;
	/** Code file this symbol belongs to (from the leaf's file node). */
	file: string;
	/** Canvas subpath, e.g. `#foo` / `#foo#2`. */
	subpath: string;
	targets: ExternalEdge[];
	included: boolean;
	edgeTags: string[];
}

function parentDirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** The first file node of any shape (a symbol-less canvas's whole-file node). */
function anyFileNode(data: any): { file: string } | null {
	const node = (Array.isArray(data?.nodes) ? data.nodes : []).find(
		(n: any) => n?.type === "file" && typeof n.file === "string",
	);
	return node ? { file: node.file } : null;
}

/**
 * Resolves the canvas that represents `dir` itself: a direct `.canvas` child
 * carrying the granularity tag, else one named per convention, else a lone
 * non-symbol canvas, else the conventional path (not yet on disk).
 */
function resolveOwnCanvas(
	parsed: Map<string, ParsedCanvas>,
	dir: TFolder,
	derivedName: string,
	granularityTag: string,
): { path: string; existing: TFile | null } {
	const direct = dir.children.filter((c): c is TFile => c instanceof TFile && c.extension === "canvas");
	const tagged = direct.filter((c) => parsed.get(c.path)?.tags.includes(granularityTag));
	if (tagged.length > 0) return { path: tagged[0].path, existing: tagged[0] };
	const byName = direct.find((c) => c.name === derivedName);
	if (byName) return { path: byName.path, existing: byName };
	const untaggedLeaves = direct.filter((c) => !parsed.get(c.path)?.tags.includes(TAG_SYMBOL));
	if (untaggedLeaves.length === 1) return { path: untaggedLeaves[0].path, existing: untaggedLeaves[0] };
	return { path: normalizePath(`${dir.path}/${derivedName}`), existing: null };
}

function walkDirs(dir: TFolder, out: TFolder[]): void {
	for (const child of dir.children) {
		if (child instanceof TFolder) {
			out.push(child);
			walkDirs(child, out);
		}
	}
}

/**
 * Carries existing text nodes (and edges touching them) over into freshly
 * laid-out canvas data. Text nodes keep their ids and positions; the other
 * endpoint of a preserved edge is remapped via its stable key (a file node's
 * `file`+`subpath`), since regenerated file nodes can get new ids (they are
 * deterministic — `stableId` — so the remap is the identity once a tree has
 * been regenerated with stable ids).
 */
function preserveTextNodes(existingData: any, data: { nodes: any[]; edges: any[] }): void {
	if (!existingData || !Array.isArray(existingData.nodes)) return;
	const textNodes = existingData.nodes.filter((n: any) => n?.type === "text" && typeof n.id === "string");
	if (textNodes.length === 0) return;
	const textIds = new Set<string>(textNodes.map((n: any) => n.id));
	const keyOf = (n: any): string | null =>
		n?.type === "file" && typeof n.file === "string" ? `${n.file}${n.subpath ?? ""}` : null;
	const newIdByKey = new Map<string, string>();
	for (const n of data.nodes) {
		const k = keyOf(n);
		if (k) newIdByKey.set(k, n.id);
	}
	const remap = new Map<string, string>();
	for (const n of existingData.nodes) {
		if (typeof n?.id !== "string") continue;
		if (textIds.has(n.id)) {
			remap.set(n.id, n.id);
			continue;
		}
		const k = keyOf(n);
		const nid = k ? newIdByKey.get(k) : undefined;
		if (nid) remap.set(n.id, nid);
	}
	data.nodes.push(...textNodes);
	const seen = new Set(data.edges.map((e) => `${e.fromNode}->${e.toNode}`));
	for (const e of Array.isArray(existingData.edges) ? existingData.edges : []) {
		if (!textIds.has(e?.fromNode) && !textIds.has(e?.toNode)) continue;
		const from = remap.get(e.fromNode);
		const to = remap.get(e.toNode);
		if (!from || !to || from === to) continue;
		const k = `${from}->${to}`;
		if (seen.has(k)) continue;
		seen.add(k);
		data.edges.push({ ...e, id: newCanvasId(), fromNode: from, toNode: to });
	}
}

/**
 * The canvas file name a `<X>_codefile` dir's own canvas should have — the
 * dir's own name. (Only a fallback: `resolveOwnCanvas` prefers the dir's
 * `codefile`-tagged canvas, which also covers trees from the old naming
 * scheme's `<X>File_codefile/<X>_codefile.canvas` sibling-folder rule.)
 */
function codefileCanvasName(dirName: string): string {
	return `${dirName}.canvas`;
}

/**
 * The merged metadata-driven command: rebuilds the aggregate canvases of
 * every flowchart tree touched by `scope` (a folder scanned recursively, or
 * an explicit list of canvases), then composes each tree's flows.json flows
 * into `main.canvas` / `main-<name>.canvas`. See the module doc.
 */
export async function regenerateFromMetadata(
	plugin: CodeFilesPlugin,
	scope: TFolder | TFile[],
): Promise<RegenerateResult> {
	const app = plugin.app;
	const candidates = Array.isArray(scope)
		? scope.filter((f) => f.extension === "canvas")
		: collectCanvasFiles(scope);

	// Group the input by generated tree (`…/flowcharts/Subflowcharts`; the
	// leading `…/` is optional — a vault-root tree is just `flowcharts/…`).
	const trees = new Map<string, TFolder>();
	for (const f of candidates) {
		const m = f.path.match(/^(?:(.*)\/)?flowcharts\/Subflowcharts(?:\/|$)/);
		if (!m) continue;
		const treePath = `${m[1] ? `${m[1]}/` : ""}flowcharts/Subflowcharts`;
		const dir = app.vault.getAbstractFileByPath(treePath);
		if (dir instanceof TFolder) trees.set(treePath, dir);
	}

	const result: RegenerateResult = {
		trees: trees.size,
		written: 0,
		edgeCount: 0,
		flows: [],
		flowErrors: [],
		missingCanvases: [],
		orphanedFlowCanvases: [],
	};
	for (const tree of trees.values()) {
		const r = await regenerateTree(plugin, tree);
		result.written += r.written;
		result.edgeCount += r.edgeCount;
		if (!tree.parent) continue;
		await migrateLegacyFlagsIfNeeded(app, tree.parent.path, collectCanvasFiles(tree));
		const f = await composeFlows(plugin, tree.parent);
		result.flows.push(...f.flows);
		result.flowErrors.push(...f.flowErrors);
		result.missingCanvases.push(...f.missingCanvases);
		result.orphanedFlowCanvases.push(...f.orphanedFlowCanvases);
	}
	result.missingCanvases = [...new Set(result.missingCanvases)].sort();
	result.orphanedFlowCanvases = [...new Set(result.orphanedFlowCanvases)].sort();
	return result;
}

async function regenerateTree(
	plugin: CodeFilesPlugin,
	tree: TFolder,
): Promise<{ written: number; edgeCount: number }> {
	const app = plugin.app;
	const nodeW = plugin.settings.canvasNodeWidth;
	const nodeH = plugin.settings.canvasNodeHeight;
	let written = 0;
	let edgeCount = 0;

	// ---- read every canvas in the tree once ----

	const parsed = await readTreeCanvases(app, tree);

	// ---- leaves: canvases tagged `symbol` ----

	const leaves: LeafInfo[] = [];
	for (const [path, p] of parsed) {
		if (!p.tags.includes(TAG_SYMBOL)) continue;
		const node = symbolFileNode(p.data);
		if (!node) continue;
		leaves.push({
			canvasPath: path,
			file: node.file,
			subpath: node.subpath,
			targets: p.tags.map(parseEdgeTag).filter((t): t is ExternalEdge => t !== null),
			included: p.tags.includes(AGGREGATE_INCLUDE_FLAG),
			edgeTags: p.tags.filter((t) => t.startsWith(EDGE_TAG_PREFIX)),
		});
	}

	// ---- codefile canvases ----

	/** dir path → aggregate info (also for symbol-less dirs, which aren't rewritten). */
	const codefileInfos = new Map<string, AggregateInfo>();

	const allDirs: TFolder[] = [];
	walkDirs(tree, allDirs);

	// ---- pre-resolve every aggregate canvas path (no writes) ----
	// Aggregate-chain tags name a target's containing codefile canvas plus its
	// ancestor subfolder canvases, so all of those paths must be known before
	// any canvas is rewritten.
	const rootName = tree.parent?.parent?.name || "root";
	const codefileCanvasByDir = new Map<string, { path: string; existing: TFile | null }>();
	const codefileCanvasByCodeFile = new Map<string, string>();
	const subfolderCanvasByDir = new Map<string, { path: string; existing: TFile | null }>();
	for (const dir of allDirs) {
		if (dir.name.endsWith(SUFFIX_CODEFILE)) {
			const own = resolveOwnCanvas(parsed, dir, codefileCanvasName(dir.name), TAG_CODEFILE);
			codefileCanvasByDir.set(dir.path, own);
			const dirLeaves = leaves.filter((l) => parentDirOf(l.canvasPath) === dir.path);
			if (dirLeaves.length > 0) {
				for (const l of dirLeaves) codefileCanvasByCodeFile.set(l.file, own.path);
			} else if (own.existing) {
				// Symbol-less file: identity comes from its whole-file node.
				const node = anyFileNode(parsed.get(own.existing.path)?.data);
				if (node) codefileCanvasByCodeFile.set(node.file, own.path);
			}
		} else if (dir.name.endsWith(SUFFIX_SUBFOLDER)) {
			subfolderCanvasByDir.set(dir.path, resolveOwnCanvas(parsed, dir, `${dir.name}.canvas`, TAG_SUBFOLDER));
		}
	}
	subfolderCanvasByDir.set(
		tree.path,
		resolveOwnCanvas(parsed, tree, `${rootName}${SUFFIX_SUBFOLDER}.canvas`, TAG_SUBFOLDER),
	);

	/**
	 * The aggregate-chain tags for a code target: its containing codefile
	 * canvas plus every ancestor subfolder canvas up to the tree's root
	 * canvas. Empty for targets no codefile canvas covers.
	 */
	const chainTagsFor = (targetFile: string, label?: string): string[] => {
		const codefile = codefileCanvasByCodeFile.get(targetFile);
		if (!codefile) return [];
		const tags = [edgeTagFor(codefile, "", label)];
		let d = parentDirOf(parentDirOf(codefile)); // the codefile dir's parent
		while (d) {
			const sub = subfolderCanvasByDir.get(d);
			if (sub) tags.push(edgeTagFor(sub.path, "", label));
			if (d === tree.path) break;
			const up = parentDirOf(d);
			if (up === d) break;
			d = up;
		}
		return tags;
	};

	for (const dir of allDirs) {
		if (!dir.name.endsWith(SUFFIX_CODEFILE)) continue;
		const dirLeaves = leaves.filter((l) => parentDirOf(l.canvasPath) === dir.path);
		const { path: canvasPath, existing } =
			codefileCanvasByDir.get(dir.path) ?? resolveOwnCanvas(parsed, dir, codefileCanvasName(dir.name), TAG_CODEFILE);

		if (dirLeaves.length === 0) {
			// Symbol-less file: keep its canvas as-is, but still participate.
			if (!existing) continue;
			const p = parsed.get(existing.path)!;
			const node = anyFileNode(p.data);
			codefileInfos.set(dir.path, {
				canvasPath: existing.path,
				included: p.tags.includes(AGGREGATE_INCLUDE_FLAG),
				coveredFiles: new Set(node ? [node.file] : []),
				externalEdges: p.tags
					.map(parseEdgeTag)
					.filter((t): t is ExternalEdge => t !== null && !t.file.endsWith(".canvas")),
				edgeTags: new Set(p.tags.filter((t) => t.startsWith(EDGE_TAG_PREFIX))),
			});
			continue;
		}

		const specs: NodeSpec[] = [];
		const keyByTarget = new Map<string, string>(); // `${file}${subpath}` → spec key
		for (const l of dirLeaves) {
			if (!l.included) continue;
			specs.push(subflowchartNodeSpec(l.canvasPath, nodeW, nodeH));
			keyByTarget.set(`${l.file}${l.subpath}`, `canvas:${l.canvasPath}`);
		}
		const edges: EdgeSpec[] = [];
		const seen = new Set<string>();
		const external: ExternalEdge[] = [];
		for (const l of dirLeaves) {
			const fromKey = `canvas:${l.canvasPath}`;
			for (const t of l.targets) {
				if (t.file.endsWith(".canvas")) continue; // chain tags are re-derived below, never drawn
				const toKey = l.included ? keyByTarget.get(`${t.file}${t.subpath}`) : undefined;
				if (!toKey || toKey === fromKey) {
					if (
						toKey !== fromKey &&
						!external.some((x) => x.file === t.file && x.subpath === t.subpath && x.label === t.label)
					) {
						external.push(t);
					}
					continue;
				}
				const dedupe = `${fromKey}->${toKey}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);
				edges.push({ fromKey, toKey, label: t.label });
			}
		}

		// Code-target tags are inherited from the leaves; aggregate-chain tags
		// are re-derived structurally (inherited ones are dropped, so a stale
		// or moved canvas path can't survive a rebuild).
		const edgeTags = new Set<string>();
		for (const l of dirLeaves) {
			for (const t of l.edgeTags) {
				const parsedTag = parseEdgeTag(t);
				if (parsedTag && parsedTag.file.endsWith(".canvas")) continue;
				edgeTags.add(t);
			}
			for (const t of l.targets) {
				if (t.file.endsWith(".canvas")) continue;
				for (const c of chainTagsFor(t.file, t.label)) {
					if (parseEdgeTag(c)?.file !== canvasPath) edgeTags.add(c);
				}
			}
		}
		const data = buildCanvasData(specs, edges, plugin);
		if (existing) preserveTextNodes(parsed.get(existing.path)?.data, data);
		const res = await writeCanvas(app, canvasPath, data, {
			tags: [TAG_CODEFILE, ...edgeTags],
			autoInclude: true,
		});
		written++;
		edgeCount += data.edges.length;
		codefileInfos.set(dir.path, {
			canvasPath,
			included: res.included,
			coveredFiles: new Set(dirLeaves.map((l) => l.file)),
			externalEdges: external,
			edgeTags,
		});
	}

	// ---- subfolder canvases, bottom-up ----

	const processFolderDir = async (dir: TFolder, isRoot: boolean): Promise<AggregateInfo | null> => {
		const children: AggregateInfo[] = [];
		for (const child of dir.children) {
			if (!(child instanceof TFolder)) continue;
			if (child.name.endsWith(SUFFIX_CODEFILE)) {
				const info = codefileInfos.get(child.path);
				if (info) children.push(info);
			} else if (child.name.endsWith(SUFFIX_SUBFOLDER)) {
				const info = await processFolderDir(child, false);
				if (info) children.push(info);
			}
		}
		if (children.length === 0) return null;

		const derivedName = isRoot ? `${rootName}${SUFFIX_SUBFOLDER}.canvas` : `${dir.name}.canvas`;
		const { path: canvasPath, existing } =
			subfolderCanvasByDir.get(dir.path) ?? resolveOwnCanvas(parsed, dir, derivedName, TAG_SUBFOLDER);

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
		if (existing) preserveTextNodes(parsed.get(existing.path)?.data, data);
		const res = await writeCanvas(app, canvasPath, data, {
			tags: [TAG_SUBFOLDER, ...[...edgeTags].filter((t) => parseEdgeTag(t)?.file !== canvasPath)],
			autoInclude: true,
		});
		written++;
		edgeCount += data.edges.length;
		return { canvasPath, included: res.included, coveredFiles, externalEdges, edgeTags };
	};
	await processFolderDir(tree, true);

	return { written, edgeCount };
}

// ---------- flow composition (flows.json → main[-<name>].canvas) ----------

export interface ComposeFlowsResult {
	flows: RegenerateFlowResult[];
	flowErrors: { name: string; error: string }[];
	missingCanvases: string[];
	orphanedFlowCanvases: string[];
}

/** Structural coverage maps of one Subflowcharts tree, read off the directory layout. */
interface TreeCoverage {
	treePath: string;
	/** `${file}${subpath}` → symbol canvas path (identity from the file node). */
	symbolCanvasByIdentity: Map<string, string>;
	/** code file path → its `<X>_codefile` canvas path. */
	codefileCanvasByCodeFile: Map<string, string>;
	/** code file path → the `<X>_codefile` dir holding its canvas. */
	codefileDirByCodeFile: Map<string, string>;
	/** dir path (incl. the tree root) → its `<Y>_subfolder` canvas path. */
	subfolderCanvasByDir: Map<string, string>;
}

function treeCoverage(parsed: Map<string, ParsedCanvas>, tree: TFolder): TreeCoverage {
	const symbolCanvasByIdentity = new Map<string, string>();
	for (const [path, p] of parsed) {
		if (!p.tags.includes(TAG_SYMBOL)) continue;
		const node = symbolFileNode(p.data);
		if (node) symbolCanvasByIdentity.set(`${node.file}${node.subpath}`, path);
	}
	const rootName = tree.parent?.parent?.name || "root";
	const codefileCanvasByCodeFile = new Map<string, string>();
	const codefileDirByCodeFile = new Map<string, string>();
	const subfolderCanvasByDir = new Map<string, string>();
	const allDirs: TFolder[] = [];
	walkDirs(tree, allDirs);
	for (const dir of allDirs) {
		if (dir.name.endsWith(SUFFIX_CODEFILE)) {
			const own = resolveOwnCanvas(parsed, dir, codefileCanvasName(dir.name), TAG_CODEFILE);
			const covered = new Set<string>();
			for (const child of dir.children) {
				if (!(child instanceof TFile) || child.extension !== "canvas") continue;
				const p = parsed.get(child.path);
				if (!p?.tags.includes(TAG_SYMBOL)) continue;
				const node = symbolFileNode(p.data);
				if (node) covered.add(node.file);
			}
			if (covered.size === 0 && own.existing) {
				// Symbol-less file: identity comes from its whole-file node.
				const node = anyFileNode(parsed.get(own.existing.path)?.data);
				if (node) covered.add(node.file);
			}
			for (const f of covered) {
				codefileCanvasByCodeFile.set(f, own.path);
				codefileDirByCodeFile.set(f, dir.path);
			}
		} else if (dir.name.endsWith(SUFFIX_SUBFOLDER)) {
			subfolderCanvasByDir.set(dir.path, resolveOwnCanvas(parsed, dir, `${dir.name}.canvas`, TAG_SUBFOLDER).path);
		}
	}
	subfolderCanvasByDir.set(
		tree.path,
		resolveOwnCanvas(parsed, tree, `${rootName}${SUFFIX_SUBFOLDER}.canvas`, TAG_SUBFOLDER).path,
	);
	return { treePath: tree.path, symbolCanvasByIdentity, codefileCanvasByCodeFile, codefileDirByCodeFile, subfolderCanvasByDir };
}

/**
 * Code references → this tree's canvases, for timeline flows built from
 * sub-flowcharts (see `SubflowchartResolver`). Folder references map a code
 * folder onto its mirrored `*_subfolder` dir via the codefile dirs below it.
 */
function subflowchartResolver(cov: TreeCoverage, parsed: Map<string, ParsedCanvas>): SubflowchartResolver {
	const identityByCanvas = new Map<string, string>();
	const identitiesByFile = new Map<string, string[]>();
	for (const [identity, canvas] of cov.symbolCanvasByIdentity) {
		identityByCanvas.set(canvas, identity);
		const file = identity.slice(0, identity.indexOf("#"));
		const list = identitiesByFile.get(file) ?? [];
		list.push(identity);
		identitiesByFile.set(file, list);
	}
	const filesByCodefileCanvas = new Map<string, string[]>();
	for (const [file, canvas] of cov.codefileCanvasByCodeFile) {
		const list = filesByCodefileCanvas.get(canvas) ?? [];
		list.push(file);
		filesByCodefileCanvas.set(canvas, list);
	}
	/** code folder → its mirrored `*_subfolder` dir ("" = the tree root). */
	const mirroredByCodeDir = new Map<string, string>();
	for (const [file, cfDir] of cov.codefileDirByCodeFile) {
		let d = parentDirOf(file);
		let m = parentDirOf(cfDir);
		for (;;) {
			if (mirroredByCodeDir.has(d)) break;
			mirroredByCodeDir.set(d, m);
			if (!d || m === cov.treePath || !m.startsWith(`${cov.treePath}/`)) break;
			d = parentDirOf(d);
			m = parentDirOf(m);
		}
	}
	const subfolderCanvases = new Map<string, string>(); // canvas → its dir
	for (const [dir, canvas] of cov.subfolderCanvasByDir) subfolderCanvases.set(canvas, dir);
	return {
		canvasFor(ref) {
			const r = ref.replace(/\\/g, "/").replace(/\/+$/, "");
			if (r.endsWith(".canvas")) return parsed.has(r) ? r : null;
			if (r.includes("#")) {
				return cov.symbolCanvasByIdentity.get(r) ?? cov.symbolCanvasByIdentity.get(r.replace(/#1$/, "")) ?? null;
			}
			const cf = cov.codefileCanvasByCodeFile.get(r);
			if (cf) return cf;
			const mirrored = mirroredByCodeDir.get(r === "/" ? "" : r);
			return mirrored !== undefined ? cov.subfolderCanvasByDir.get(mirrored) ?? null : null;
		},
		identitiesOf(canvas) {
			const own = identityByCanvas.get(canvas);
			if (own) return [own];
			const files = filesByCodefileCanvas.get(canvas);
			if (files) return files.flatMap((f) => identitiesByFile.get(f) ?? []);
			const dir = subfolderCanvases.get(canvas);
			if (dir === undefined) return [];
			const out: string[] = [];
			for (const [file, cfDir] of cov.codefileDirByCodeFile) {
				if (dir === cov.treePath || cfDir.startsWith(`${dir}/`)) out.push(...(identitiesByFile.get(file) ?? []));
			}
			return out;
		},
		isTreeCanvas(path) {
			return parsed.has(path);
		},
	};
}

/**
 * Composes the flows of one `…/flowcharts` folder's flows.json — all of
 * them, or only `names` — into their canvases: list flows into
 * `<flowcharts>/<flowCanvasFileName(name)>` (see the module doc for the edge
 * resolution rules and shared-code links), timeline flows into their
 * `output` (see flowchartTimeline.ts). The folder's `Subflowcharts` tree is
 * read only when a flow needs it (list flows, timeline `code-links`), and at
 * most once.
 */
export async function composeFlows(
	plugin: CodeFilesPlugin,
	flowchartsFolder: TFolder,
	names?: string[],
): Promise<ComposeFlowsResult> {
	const app = plugin.app;
	const nodeW = plugin.settings.canvasNodeWidth;
	const nodeH = plugin.settings.canvasNodeHeight;
	const manifest = await readFlowsManifest(app, flowchartsFolder.path);
	const allNames = Object.keys(manifest.flows).sort();
	const flowErrors: { name: string; error: string }[] = [];

	// Orphaned composed canvases: direct `main-*.canvas` children of the
	// flowcharts folder whose flow name is no longer in flows.json (a flow
	// was renamed or removed). Report-only — never deleted. `main.canvas`
	// itself is the default flow's file and is never an orphan.
	const expected = new Set(allNames.map((n) => flowCanvasFileName(n)));
	const orphanedFlowCanvases = flowchartsFolder.children
		.filter(
			(c): c is TFile =>
				c instanceof TFile &&
				c.extension === "canvas" &&
				c.name.startsWith("main-") &&
				!expected.has(c.name),
		)
		.map((c) => c.path)
		.sort();

	const selected = names ? allNames.filter((n) => names.includes(n)) : allNames;
	for (const n of names ?? []) {
		if (!(n in manifest.flows)) flowErrors.push({ name: n, error: `no flow "${n}" in ${flowchartsFolder.path}/flows.json` });
	}
	if (selected.length === 0) return { flows: [], flowErrors, missingCanvases: [], orphanedFlowCanvases };

	const treeDir = app.vault.getAbstractFileByPath(normalizePath(`${flowchartsFolder.path}/Subflowcharts`));
	const tree = treeDir instanceof TFolder ? treeDir : null;
	// Read lazily, once — a fresh read: regenerateTree may just have rewritten the tree.
	let parsed: Map<string, ParsedCanvas> | null = null;
	let coverage: TreeCoverage | null = null;
	let index: CodeIndex | null = null;
	const getParsed = async (): Promise<Map<string, ParsedCanvas>> => {
		if (!parsed) parsed = tree ? await readTreeCanvases(app, tree) : new Map();
		return parsed;
	};
	const getCoverage = async (): Promise<TreeCoverage | null> => {
		if (!tree) return null;
		if (!coverage) coverage = treeCoverage(await getParsed(), tree);
		return coverage;
	};
	const getIndex = async (): Promise<CodeIndex | null> => {
		if (!tree) return null;
		if (!index) index = buildCodeIndex(await getParsed());
		return index;
	};
	const sides = parseCodeSides(plugin.settings.codeSides);

	const results: RegenerateFlowResult[] = [];
	const missing: string[] = [];
	for (const name of selected) {
		const entry: Record<string, any> | string[] = manifest.flows[name];
		const obj = (Array.isArray(entry) ? {} : entry) as Record<string, any>;

		if (isTimelineFlow(entry)) {
			const links = obj["code-links"];
			const wantsIndex = links !== false && !(links && typeof links === "object" && links.mode === "off");
			try {
				const r = await composeTimelineFlow(app, name, obj, {
					styles: manifest.styles,
					defaultOutput: normalizePath(`${flowchartsFolder.path}/${flowCanvasFileName(name)}`),
					manifestPath: normalizePath(`${flowchartsFolder.path}/flows.json`),
					index: wantsIndex ? await getIndex() : null,
					sides,
					resolver: tree ? subflowchartResolver((await getCoverage())!, await getParsed()) : null,
				});
				results.push({ name, path: r.path, kind: "timeline", included: r.cards, edgeCount: r.edges, timeline: r });
			} catch (e) {
				if (!(e instanceof TimelineSpecError)) throw e;
				flowErrors.push({ name, error: e.message });
			}
			continue;
		}
		if (!isListFlow(entry)) {
			flowErrors.push({ name, error: `flow "${name}" is neither a list of canvases, {"members": […]} nor {"layout": "timeline"}` });
			continue;
		}

		const members = new Set<string>();
		for (const p of flowMembers(entry)) {
			const f = app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile && f.extension === "canvas") members.add(f.path);
			else missing.push(p);
		}
		if (members.size === 0) continue;
		const cov = await getCoverage();
		const treeParsed = await getParsed();

		// Member edge tags (members outside the tree are read on demand).
		const tagsByMember = new Map<string, string[]>();
		for (const m of members) {
			const p = treeParsed.get(m);
			if (p) {
				tagsByMember.set(m, p.tags);
			} else {
				const f = app.vault.getAbstractFileByPath(m);
				tagsByMember.set(m, f instanceof TFile ? await readCanvasTags(app, f) : []);
			}
		}

		/**
		 * The nearest OTHER flow member covering a code target: the member
		 * symbol canvas matching `file`+`subpath`, else the member codefile
		 * canvas covering the file, else the nearest member ancestor subfolder
		 * canvas. Null when no member covers it.
		 */
		const resolveMember = (fromCanvas: string | null, target: ExternalEdge): string | null => {
			if (!cov) return null;
			if (target.subpath) {
				const sym = cov.symbolCanvasByIdentity.get(`${target.file}${target.subpath}`);
				if (sym && sym !== fromCanvas && members.has(sym)) return sym;
			}
			const cf = cov.codefileCanvasByCodeFile.get(target.file);
			if (cf && cf !== fromCanvas && members.has(cf)) return cf;
			let d = cov.codefileDirByCodeFile.get(target.file);
			if (!d) return null;
			d = parentDirOf(d);
			while (d) {
				const sub = cov.subfolderCanvasByDir.get(d);
				if (sub && sub !== fromCanvas && members.has(sub)) return sub;
				if (d === cov.treePath) break;
				const up = parentDirOf(d);
				if (up === d) break;
				d = up;
			}
			return null;
		};

		const specs: NodeSpec[] = [...members].sort().map((p) => subflowchartNodeSpec(p, nodeW, nodeH));
		const edges: EdgeSpec[] = [];
		const seen = new Set<string>();
		for (const from of [...members].sort()) {
			for (const tag of tagsByMember.get(from) ?? []) {
				const t = parseEdgeTag(tag);
				if (!t || t.file.endsWith(".canvas")) continue; // chain tags are never drawn
				const to = resolveMember(from, t);
				if (!to) continue;
				const dedupe = `${from}->${to}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);
				edges.push({ fromKey: `canvas:${from}`, toKey: `canvas:${to}`, label: t.label });
			}
		}

		let sharedEdgeCount: number | undefined;
		if (obj["shared-links"] && cov) {
			const flowSides = obj.sides ? parseCodeSides(obj.sides) : sides;
			const shared = sharedMemberLinks([...members].sort(), tagsByMember, cov, treeParsed, resolveMember, flowSides, obj);
			sharedEdgeCount = shared.length;
			edges.push(...shared);
		}

		const path = normalizePath(`${flowchartsFolder.path}/${flowCanvasFileName(name)}`);
		const data = buildCanvasData(specs, edges, plugin);
		await writeCanvas(app, path, data); // no managed tags, no autoInclude
		results.push({ name, path, kind: "list", included: members.size, edgeCount: data.edges.length, sharedEdgeCount });
	}
	return { flows: results, flowErrors, missingCanvases: missing, orphanedFlowCanvases };
}

/**
 * Shared-code links between list-flow members: one dotted, arrowless edge
 * per pair of members on different code sides that both use (unlabelled
 * code-level tags) symbols that no member covers and that live on neither
 * side. Labelled `shares \`x\`` for one symbol, `shares \`x\`, \`y\` +N`
 * otherwise. Options on the flow entry: `shared-ignore` (path globs),
 * `shared-min` (fewest shared symbols for a pair to count, default 1),
 * `shared-color`.
 */
function sharedMemberLinks(
	members: string[],
	tagsByMember: Map<string, string[]>,
	cov: TreeCoverage,
	parsed: Map<string, ParsedCanvas>,
	resolveMember: (fromCanvas: string | null, target: ExternalEdge) => string | null,
	sides: CodeSide[],
	entry: Record<string, any>,
): EdgeSpec[] {
	const ignore = (Array.isArray(entry["shared-ignore"]) ? entry["shared-ignore"] : [])
		.filter((g: unknown): g is string => typeof g === "string")
		.map(globToRegExp);
	const minShared = typeof entry["shared-min"] === "number" ? entry["shared-min"] : 1;

	// The code files each member covers → its side (null when mixed or unknown).
	const filesOf = (m: string): string[] => {
		const sym = symbolFileNode(parsed.get(m)?.data);
		if (sym && parsed.get(m)?.tags.includes(TAG_SYMBOL)) return [sym.file];
		const dir = parentDirOf(m);
		const out: string[] = [];
		for (const [file, cfDir] of cov.codefileDirByCodeFile) {
			if (cfDir === dir || cfDir.startsWith(`${dir}/`) || dir === cov.treePath) out.push(file);
		}
		return out;
	};
	const memberFiles = new Map(members.map((m) => [m, new Set(filesOf(m))]));
	const memberSide = new Map<string, string | null>();
	for (const m of members) {
		const s = new Set([...memberFiles.get(m)!].map((f) => sideOf(f, sides)));
		memberSide.set(m, s.size === 1 ? [...s][0] : null);
	}

	/** shared identity → members using it. */
	const users = new Map<string, Set<string>>();
	for (const m of members) {
		const side = memberSide.get(m);
		if (!side) continue;
		for (const tag of tagsByMember.get(m) ?? []) {
			const t = parseEdgeTag(tag);
			if (!t || t.label || !t.subpath || t.file.endsWith(".canvas")) continue;
			if (memberFiles.get(m)!.has(t.file)) continue; // its own code
			if (resolveMember(null, t)) continue; // another member covers it: a direct edge, not shared
			const tSide = sideOf(t.file, sides);
			const isShared = sides.length > 0 ? tSide === null : tSide !== side;
			if (!isShared || ignore.some((re: RegExp) => re.test(t.file))) continue;
			const id = `${t.file}${t.subpath}`;
			const set = users.get(id) ?? new Set<string>();
			set.add(m);
			users.set(id, set);
		}
	}
	const pairs = new Map<string, { a: string; b: string; names: string[] }>();
	for (const [id, set] of users) {
		const list = [...set].sort();
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				if (memberSide.get(list[i]) === memberSide.get(list[j])) continue;
				const key = `${list[i]}|${list[j]}`;
				const p = pairs.get(key) ?? { a: list[i], b: list[j], names: [] };
				p.names.push(symbolNameOf(id));
				pairs.set(key, p);
			}
		}
	}
	const edges: EdgeSpec[] = [];
	for (const p of [...pairs.values()].sort((x, y) => (x.a + x.b).localeCompare(y.a + y.b))) {
		// Functions first (they say what is shared), then types/constants; alphabetical within each.
		const fnFirst = (n: string) => (/^[a-z_]/.test(n) ? 0 : 1);
		const names = [...new Set(p.names)].sort((x, y) => fnFirst(x) - fnFirst(y) || x.localeCompare(y));
		if (names.length < minShared) continue;
		const shown = names.slice(0, 2).map((n) => `\`${n}\``).join(", ");
		const label = names.length > 2 ? `shares ${shown} +${names.length - 2}` : `shares ${shown}`;
		const extra: Record<string, any> = { styleAttributes: { path: "dotted" }, toEnd: "none" };
		if (typeof entry["shared-color"] === "string") extra.color = entry["shared-color"];
		edges.push({ fromKey: `canvas:${p.a}`, toKey: `canvas:${p.b}`, label, extra });
	}
	return edges;
}
