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
	migrateLegacyFlagsIfNeeded,
	readFlows,
} from "./flowchartFlows";

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
	included: number;
	edgeCount: number;
}

export interface RegenerateResult {
	trees: number;
	written: number;
	edgeCount: number;
	flows: RegenerateFlowResult[];
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

type ParsedCanvas = { file: TFile; data: any; tags: string[] };

function tagsFromData(data: any): string[] {
	const tags = data?.metadata?.frontmatter?.tags;
	if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === "string");
	if (typeof tags === "string") return [tags];
	return [];
}

function parentDirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** Reads and parses every canvas under `tree` once (unparseable ones are skipped). */
async function readTreeCanvases(app: App, tree: TFolder): Promise<Map<string, ParsedCanvas>> {
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
function symbolFileNode(data: any): { file: string; subpath: string } | null {
	const node = (Array.isArray(data?.nodes) ? data.nodes : []).find(
		(n: any) => n?.type === "file" && typeof n.file === "string" && typeof n.subpath === "string",
	);
	return node ? { file: node.file, subpath: node.subpath } : null;
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

/** The canvas file name a `<X>_codefile` dir's own canvas should have. */
function codefileCanvasName(dirName: string): string {
	const base = dirName.endsWith(`File${SUFFIX_CODEFILE}`)
		? `${dirName.slice(0, -`File${SUFFIX_CODEFILE}`.length)}${SUFFIX_CODEFILE}`
		: dirName;
	return `${base}.canvas`;
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

	const result: RegenerateResult = { trees: trees.size, written: 0, edgeCount: 0, flows: [], missingCanvases: [], orphanedFlowCanvases: [] };
	for (const tree of trees.values()) {
		const r = await regenerateTree(plugin, tree);
		result.written += r.written;
		result.edgeCount += r.edgeCount;
		const f = await composeFlows(plugin, tree);
		result.flows.push(...f.flows);
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

/**
 * Composes every flow in the tree's flows.json (migrating legacy
 * `includeInMainFlowchart` tags on first run) into
 * `<flowcharts>/<flowCanvasFileName(name)>`. See the module doc for the edge
 * resolution rules.
 */
async function composeFlows(
	plugin: CodeFilesPlugin,
	tree: TFolder,
): Promise<{ flows: RegenerateFlowResult[]; missingCanvases: string[]; orphanedFlowCanvases: string[] }> {
	const app = plugin.app;
	const flowchartsFolder = tree.parent;
	if (!flowchartsFolder) return { flows: [], missingCanvases: [], orphanedFlowCanvases: [] };
	const nodeW = plugin.settings.canvasNodeWidth;
	const nodeH = plugin.settings.canvasNodeHeight;

	await migrateLegacyFlagsIfNeeded(app, flowchartsFolder.path, collectCanvasFiles(tree));
	const flows = await readFlows(app, flowchartsFolder.path);
	const names = Object.keys(flows).sort();

	// Orphaned composed canvases: direct `main-*.canvas` children of the
	// flowcharts folder whose flow name is no longer in flows.json (a flow
	// was renamed or removed). Report-only — never deleted. `main.canvas`
	// itself is the default flow's file and is never an orphan.
	const expected = new Set(names.map((n) => flowCanvasFileName(n)));
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

	if (names.length === 0) return { flows: [], missingCanvases: [], orphanedFlowCanvases };

	// Fresh read — regenerateTree just rewrote the tree's canvases.
	const parsed = await readTreeCanvases(app, tree);

	// ---- structural coverage maps ----

	/** `${file}${subpath}` → symbol canvas path (identity from the file node). */
	const symbolCanvasByIdentity = new Map<string, string>();
	for (const [path, p] of parsed) {
		if (!p.tags.includes(TAG_SYMBOL)) continue;
		const node = symbolFileNode(p.data);
		if (node) symbolCanvasByIdentity.set(`${node.file}${node.subpath}`, path);
	}
	const rootName = tree.parent?.parent?.name || "root";
	/** code file path → its `<X>_codefile` canvas path. */
	const codefileCanvasByCodeFile = new Map<string, string>();
	/** code file path → the `<X>_codefile` dir holding its canvas. */
	const codefileDirByCodeFile = new Map<string, string>();
	/** dir path (incl. the tree root) → its `<Y>_subfolder` canvas path. */
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

	const results: RegenerateFlowResult[] = [];
	const missing: string[] = [];
	for (const name of names) {
		const members = new Set<string>();
		for (const p of flows[name]) {
			const f = app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile && f.extension === "canvas") members.add(f.path);
			else missing.push(p);
		}
		if (members.size === 0) continue;

		// Member edge tags (members outside the tree are read on demand).
		const tagsByMember = new Map<string, string[]>();
		for (const m of members) {
			const p = parsed.get(m);
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
		const resolveMember = (fromCanvas: string, target: ExternalEdge): string | null => {
			if (target.subpath) {
				const sym = symbolCanvasByIdentity.get(`${target.file}${target.subpath}`);
				if (sym && sym !== fromCanvas && members.has(sym)) return sym;
			}
			const cf = codefileCanvasByCodeFile.get(target.file);
			if (cf && cf !== fromCanvas && members.has(cf)) return cf;
			let d = codefileDirByCodeFile.get(target.file);
			if (!d) return null;
			d = parentDirOf(d);
			while (d) {
				const sub = subfolderCanvasByDir.get(d);
				if (sub && sub !== fromCanvas && members.has(sub)) return sub;
				if (d === tree.path) break;
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

		const path = normalizePath(`${flowchartsFolder.path}/${flowCanvasFileName(name)}`);
		const data = buildCanvasData(specs, edges, plugin);
		await writeCanvas(app, path, data); // no managed tags, no autoInclude
		results.push({ name, path, included: members.size, edgeCount: data.edges.length });
	}
	return { flows: results, missingCanvases: missing, orphanedFlowCanvases };
}
