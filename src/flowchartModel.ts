import { TFile, TFolder } from "obsidian";
import CodeFilesPlugin from "./main";
import { SymbolInfo, isSymbolCapableExtension } from "./symbolResolver";
import { CROSS_EDGE_KINDS, CrossSymbolEdge, ImportTarget, attributeRowsAbove, detectCrossFileEdges } from "./flowchartCrossEdges";
import { TscnRef, detectTscnRefs } from "./flowchartTscn";
import { isIgnoredFolderPath, parseIgnorePatterns } from "./folderIgnore";

/**
 * Builds the code-graph model behind the flowchart canvases: which files are
 * in scope, their linkable symbols (per the plugin settings), a vault-scope
 * index of SpacetimeDB reducers, and heuristic edges (client `Reducers.*`
 * call sites, client `.Db.*` table reads, same-file Rust calls, cross-file
 * Rust references and SpacetimeDB table / Rust SDK usage — see
 * flowchartCrossEdges.ts — and `.tscn` scene wiring — see flowchartTscn.ts).
 *
 * `.tscn` files are always collected (unioned into the passed extensions)
 * even though they predate the extension setting: they carry the client app's
 * scene→script / scene→scene / scene→table wiring.
 */

/** A heuristic edge detected from a file's code (symbol → symbol / reducer / table). */
export interface AutoEdge {
	from: string;
	/**
	 * 1-based occurrence pinning `from` to a specific same-named owner symbol
	 * (overloads sharing a name). Set by all detectors from the owning
	 * `SymbolInfo`; consumers fall back to the first match when unset
	 * (legacy edges).
	 */
	fromOccurrence?: number;
	to: string;
	label?: string;
	/**
	 * 1-based occurrence pinning `to` to a specific same-named symbol (set by
	 * the `Type::method(` pass of the same-file detector, which resolves the
	 * method through its impl container). Consumers fall back to the first
	 * occurrence when unset.
	 */
	toOccurrence?: number;
}

/** PascalCase / camelCase → snake_case (CreateProfile → create_profile). */
export function toSnakeCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase();
}

/** Folders never scanned or written into, regardless of settings. */
export const SKIP_DIR_NAMES = new Set(["flowcharts", "node_modules"]);

/**
 * Folders holding generated bindings — skipped unless `includeGeneratedCodeFiles` opts back in
 * (kept separate from `SKIP_DIR_NAMES` so those two output/vendor dirs are never scannable).
 */
export const GENERATED_DIR_NAMES = new Set(["module_bindings"]);

/** Generated binding files are never touched. */
function isGeneratedFile(file: TFile): boolean {
	return file.name.endsWith(".g.cs");
}

/** An edge owned by a file itself rather than a symbol (`.tscn` wiring, module imports). */
export interface ResolvedFileEdge {
	toFile: TFile;
	/** The targeted symbol (attached script's class, bound table's struct/view fn); null = whole file. */
	toSym: SymbolInfo | null;
	/** `script` / `scene` / `class` / `bind` for `.tscn` wiring, `import` for `use` statements. */
	label: string;
}

export interface FlowchartFile {
	file: TFile;
	symbols: SymbolInfo[];
	/** Names of functions in this file that are SpacetimeDB reducers. */
	reducerFns: Set<string>;
	/** Heuristic edges detected from the code (reducer calls / table reads / same-file calls). */
	detectedEdges: AutoEdge[];
	/** Resolved cross-file reference edges (rs via flowchartCrossEdges.ts, plus C# table-name strings). */
	crossDetectedEdges: CrossSymbolEdge[];
	/** File-owned edges (`.tscn` script/scene/class/table wiring); empty for non-scene files. */
	fileEdges: ResolvedFileEdge[];
	/**
	 * Module-level `use`/`pub use` statements that name another in-scope file's
	 * symbol without the name ever appearing inside a declaration (see
	 * flowchartCrossEdges.ts). File-owned like the `.tscn` wiring, but *not*
	 * drawn on flowchart canvases — they are import noise there. Only the
	 * pointer index consumes them, as a fallback when no symbol-level usage of
	 * the same target exists in that file.
	 */
	importEdges: ResolvedFileEdge[];
}

export interface ReducerTarget {
	file: TFile;
	fnName: string;
}

export interface FlowchartModel {
	root: TFolder;
	files: FlowchartFile[];
	/** snake_case reducer name → defining function (rs files in scope). */
	reducerIndex: Map<string, ReducerTarget>;
	/** SpacetimeDB table/view accessor name → defining symbol (rs files in scope). */
	accessorIndex: Map<string, ImportTarget>;
}

/**
 * Recursively collects matching files under `folder`, skipping generated/output dirs.
 * `includeGenerated` opts back in to `*.g.cs`-style generated binding files, which are
 * excluded by default (`settings.includeGeneratedCodeFiles`). `ignoredFolders` are the
 * user's folder-ignore patterns (`settings.ignoredFolders`, see folderIgnore.ts) — a
 * matching folder and everything under it are skipped.
 */
export function collectCodeFiles(
	folder: TFolder,
	extensions: string[],
	includeGenerated = false,
	ignoredFolders: string[] = [],
): TFile[] {
	const out: TFile[] = [];
	const walk = (dir: TFolder) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) {
				if (SKIP_DIR_NAMES.has(child.name) || child.name.startsWith(".")) continue;
				if (!includeGenerated && GENERATED_DIR_NAMES.has(child.name)) continue;
				if (isIgnoredFolderPath(child.path, ignoredFolders)) continue;
				walk(child);
			} else if (child instanceof TFile) {
				if (!includeGenerated && isGeneratedFile(child)) continue;
				if (extensions.includes(child.extension)) out.push(child);
			}
		}
	};
	walk(folder);
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

/** Counts matching files per extension under a folder (for menu labels). */
export function countByExtension(
	folder: TFolder,
	extensions: string[],
	includeGenerated = false,
	ignoredFolders: string[] = [],
): Map<string, number> {
	const counts = new Map<string, number>();
	const exts = [...new Set([...extensions, "tscn"])];
	for (const file of collectCodeFiles(folder, exts, includeGenerated, ignoredFolders)) {
		counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);
	}
	return counts;
}

export async function buildFlowchartModel(
	plugin: CodeFilesPlugin,
	root: TFolder,
	extensions: string[],
): Promise<FlowchartModel> {
	const model: FlowchartModel = { root, files: [], reducerIndex: new Map(), accessorIndex: new Map() };
	// `.tscn` scene files always participate — they carry the client app's
	// scene→script / scene→scene / scene→table wiring (see flowchartTscn.ts).
	const exts = [...new Set([...extensions, "tscn"])];

	/** Raw refs of each `.tscn` file, resolved in the post-pass below. */
	const tscnRefs = new Map<FlowchartFile, TscnRef[]>();

	const ignoredFolders = parseIgnorePatterns(plugin.settings.ignoredFolders);
	for (const file of collectCodeFiles(root, exts, plugin.settings.includeGeneratedCodeFiles, ignoredFolders)) {
		const content = await plugin.app.vault.cachedRead(file);
		const symbols = isSymbolCapableExtension(file.extension)
			? await plugin.symbolResolver.listSymbols(content, file.extension, plugin.settings.linkableSymbolKinds)
			: [];
		// Edge/reducer heuristics operate on functions only — a variable or type
		// declaration must never become an edge owner or callee.
		const functions = symbols.filter((s) => s.kind === "function");
		const reducerFns = file.extension === "rs" ? detectReducerFns(content, functions) : new Set<string>();
		const detectedEdges = detectHeuristicEdges(content, file.extension, functions);

		const entry: FlowchartFile = {
			file,
			symbols,
			reducerFns,
			detectedEdges,
			crossDetectedEdges: [],
			fileEdges: [],
			importEdges: [],
		};
		model.files.push(entry);
		if (file.extension === "tscn") tscnRefs.set(entry, detectTscnRefs(content));

		for (const fnName of reducerFns) {
			model.reducerIndex.set(fnName, { file, fnName });
		}
	}

	// Cross-file rs references (glob-import calls, type mentions, table
	// handles) — needs every file's symbols, so this is a post-pass. Returns
	// the SpacetimeDB accessor index shared by the C#/`.tscn` table detectors
	// (`reducer:` / `table:` refs are resolved against these indexes by the
	// canvas generation layer).
	model.accessorIndex = await detectCrossFileEdges(plugin.app, root, model.files);

	resolveTscnFileEdges(plugin, model, tscnRefs);
	await detectTableNameStrings(plugin, model);

	return model;
}

/** The Godot project root of a `.tscn` file: nearest ancestor folder holding `project.godot`. */
function godotRootFor(file: TFile): string | null {
	let dir = file.parent;
	while (dir) {
		if (dir.children.some((c) => c instanceof TFile && c.name === "project.godot")) return dir.path;
		dir = dir.parent;
	}
	return null;
}

/**
 * Resolves `.tscn` refs into file-owned edges (`FlowchartFile.fileEdges`).
 * `res://` maps onto the enclosing Godot
 * project root; refs whose target leaves the vault are dropped. Script refs
 * target the script's class symbol when one is in scope (basename match, else
 * first class), scene refs are whole-file, table refs resolve a PascalCase
 * name against the accessor index, and custom node types (`type="KgX"`, the
 * GDExtension wiring) resolve against the scanned class/struct symbols — a
 * built-in Godot type matches nothing and is dropped.
 */
function resolveTscnFileEdges(
	plugin: CodeFilesPlugin,
	model: FlowchartModel,
	tscnRefs: Map<FlowchartFile, TscnRef[]>,
): void {
	const app = plugin.app;
	const byPath = new Map(model.files.map((ff) => [ff.file.path, ff]));
	// Custom node type name → declaring symbol. Rust GDExtension classes are
	// structs (C# ones are classes); a name matching neither is a built-in.
	const classIndex = new Map<string, ImportTarget>();
	for (const ff of model.files) {
		for (const sym of ff.symbols) {
			if (sym.kind !== "class" && sym.kind !== "struct") continue;
			const existing = classIndex.get(sym.name);
			if (!existing || (existing.sym.kind !== "class" && sym.kind === "class")) {
				classIndex.set(sym.name, { ff, sym });
			}
		}
	}
	for (const [ff, refs] of tscnRefs) {
		const godotRoot = godotRootFor(ff.file);
		const seen = new Set<string>();
		const push = (toFile: TFile, toSym: SymbolInfo | null, label: string) => {
			const key = `${toFile.path}#${toSym?.name ?? ""}:${label}`;
			if (seen.has(key)) return;
			seen.add(key);
			ff.fileEdges.push({ toFile, toSym, label });
		};
		for (const ref of refs) {
			if (ref.kind === "table") {
				const target = model.accessorIndex.get(toSnakeCase(ref.tableName!));
				if (target) push(target.ff.file, target.sym, "bind");
				continue;
			}
			if (ref.kind === "class") {
				const target = classIndex.get(ref.className!);
				if (target) push(target.ff.file, target.sym, "class");
				continue;
			}
			if (!godotRoot || !ref.resPath) continue;
			const vaultPath = `${godotRoot === "/" ? "" : `${godotRoot}/`}${ref.resPath.slice("res://".length)}`;
			const toFileOrFolder = app.vault.getAbstractFileByPath(vaultPath);
			if (!(toFileOrFolder instanceof TFile)) continue;
			const toFile = toFileOrFolder;
			if (ref.kind === "scene") {
				push(toFile, null, "scene");
				continue;
			}
			// script edge → the attached script's class symbol
			const targetFf = byPath.get(toFile.path);
			const classes = targetFf?.symbols.filter((s) => s.kind === "class") ?? [];
			const sym =
				classes.find((s) => s.name.toLowerCase() === toFile.basename.toLowerCase()) ?? classes[0] ?? null;
			push(toFile, sym, "script");
		}
	}
}

/** snake_case accessor → PascalCase (`nearby_remote_players` → `NearbyRemotePlayers`). */
function toPascalCase(accessor: string): string {
	return accessor
		.split("_")
		.map((s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s))
		.join("");
}

/**
 * C# string literals that exactly name a known SpacetimeDB table/view — the
 * declarative subscription lists (`TableSubscriber`'s `BaseTables` /
 * `LobbyTables` / `GameTables` arrays). Index-driven, so unrelated strings
 * produce nothing. Owners are any edgeable kind: these arrays are class-level
 * field initializers, not inside functions. Labeled `subscribe`.
 */
async function detectTableNameStrings(plugin: CodeFilesPlugin, model: FlowchartModel): Promise<void> {
	if (model.accessorIndex.size === 0) return;
	const pascalIndex = new Map<string, ImportTarget>();
	for (const [accessor, target] of model.accessorIndex) {
		const pascal = toPascalCase(accessor);
		if (!pascalIndex.has(pascal)) pascalIndex.set(pascal, target);
	}
	const reStr = /"([A-Z][A-Za-z0-9]*)"/g;
	for (const ff of model.files) {
		if (ff.file.extension !== "cs") continue;
		const content = await plugin.app.vault.cachedRead(ff.file);
		const lines = content.split("\n");
		const seen = new Set<string>();
		for (let row = 0; row < lines.length; row++) {
			reStr.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = reStr.exec(lines[row])) !== null) {
				const target = pascalIndex.get(m[1]);
				if (!target || target.ff === ff) continue;
				const owner = innermostSymbolOfKinds(ff.symbols, row + 1);
				if (!owner) continue;
				const key = `${owner.name}->${m[1]}`;
				if (seen.has(key)) continue;
				seen.add(key);
				ff.crossDetectedEdges.push({
					from: owner.name,
					fromOccurrence: owner.occurrence,
					toFile: target.ff.file,
					toSym: target.sym,
					label: "subscribe",
				});
			}
		}
	}
}

/**
 * A Rust function is a reducer when a `#[...reducer...]` attribute sits in the
 * contiguous attribute/doc block directly above it (paren-balance-aware, so
 * multi-line attribute blocks don't truncate the search). Doc comments are
 * skipped: `/// Called by every admin reducer.` above a helper is prose.
 */
function detectReducerFns(content: string, symbols: SymbolInfo[]): Set<string> {
	const lines = content.split("\n");
	const out = new Set<string>();
	for (const sym of symbols) {
		for (const row of attributeRowsAbove(lines, sym.startLine)) {
			const line = lines[row - 1].trim();
			if (!line.startsWith("//") && /\breducer\b/.test(line)) {
				out.add(sym.name);
				break;
			}
		}
	}
	return out;
}

export function detectHeuristicEdges(content: string, extension: string, symbols: SymbolInfo[]): AutoEdge[] {
	if (extension === "cs") return [...detectReducerCalls(content, symbols), ...detectTableReads(content, symbols)];
	if (extension === "rs") return detectSameFileCalls(content, symbols);
	return [];
}

/**
 * The innermost function whose range contains `line` (1-based). `symbols` is
 * already function-only; smallest range wins so nested/local functions own
 * their call sites instead of the outer function.
 */
function innermostOwner(symbols: SymbolInfo[], line: number): SymbolInfo | null {
	let best: SymbolInfo | null = null;
	for (const s of symbols) {
		if (s.startLine <= line && line <= s.endLine) {
			if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
		}
	}
	return best;
}

/** The innermost edgeable-kind symbol (functions, classes, …) containing `line` (1-based). */
function innermostSymbolOfKinds(symbols: SymbolInfo[], line: number): SymbolInfo | null {
	let best: SymbolInfo | null = null;
	for (const s of symbols) {
		if (!CROSS_EDGE_KINDS.has(s.kind)) continue;
		if (s.startLine <= line && line <= s.endLine) {
			if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
		}
	}
	return best;
}

/** C# `Reducers.XxxYyy(...)` call sites → `reducer:xxx_yyy` edges from the containing function. */
function detectReducerCalls(content: string, symbols: SymbolInfo[]): AutoEdge[] {
	const lines = content.split("\n");
	const re = /Reducers\.([A-Z]\w*)\s*\(/g;
	const seen = new Set<string>();
	const out: AutoEdge[] = [];
	for (let row = 0; row < lines.length; row++) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(lines[row])) !== null) {
			const owner = innermostOwner(symbols, row + 1);
			if (!owner) continue;
			const key = `${owner.name}#${owner.occurrence}->${m[1]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ from: owner.name, fromOccurrence: owner.occurrence, to: `reducer:${toSnakeCase(m[1])}`, label: "rpc" });
		}
	}
	return out;
}

/**
 * C# `.Db.XxxYyy` property reads (the generated `DbConnection.Db` table
 * handles: `conn.Db.LocalPlayer.Iter()`, `…Db.PlayerStats.ProfileId.Find(..)`,
 * `OnInsert` hooks) → `table:XxxYyy` edges from the containing function,
 * resolved against the accessor index in `buildFlowchartModel`. Labeled `read`
 * (client table replicas are read-only; mutation goes through reducers).
 */
function detectTableReads(content: string, symbols: SymbolInfo[]): AutoEdge[] {
	const lines = content.split("\n");
	const re = /\.Db\.([A-Z]\w*)/g;
	const seen = new Set<string>();
	const out: AutoEdge[] = [];
	for (let row = 0; row < lines.length; row++) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(lines[row])) !== null) {
			const owner = innermostOwner(symbols, row + 1);
			if (!owner) continue;
			const key = `${owner.name}#${owner.occurrence}->${m[1]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ from: owner.name, fromOccurrence: owner.occurrence, to: `table:${m[1]}`, label: "read" });
		}
	}
	return out;
}

/**
 * Rust calls between functions of the same file (callee in `symbols`, no
 * self-edges). `Type::method(...)` call sites are resolved through the impl
 * container first (`TextureEntry::seed(…)` → the `seed` whose container is
 * `TextureEntry`, not the first `seed` in the file); the bare-name pass then
 * skips anything preceded by `::` so typed calls are filed exactly once.
 */
function detectSameFileCalls(content: string, symbols: SymbolInfo[]): AutoEdge[] {
	const lines = content.split("\n");
	/**
	 * Pass 1 dedupes per occurrence (typed calls to two different impls of a
	 * same-named method are distinct edges); pass 2 dedupes per name, and a
	 * name already filed by either pass suppresses bare matches (typed edges
	 * take precedence).
	 */
	const seen = new Set<string>();
	const seenNames = new Set<string>();
	const out: AutoEdge[] = [];

	// Pass 1 — `Type::method(` sites, resolved via the container chain.
	const byName = new Map<string, SymbolInfo[]>();
	for (const s of symbols) {
		const g = byName.get(s.name);
		if (g) g.push(s);
		else byName.set(s.name, [s]);
	}
	const reTyped = /\b([A-Z]\w*)::(\w+)\s*\(/g;
	for (let row = 0; row < lines.length; row++) {
		reTyped.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = reTyped.exec(lines[row])) !== null) {
			const typeName = m[1];
			const methodName = m[2];
			const candidates = (byName.get(methodName) ?? []).filter((s) => {
				const last = s.container?.split(".").pop();
				return last === typeName;
			});
			if (candidates.length === 0) continue; // foreign type — the cross-file mention scan owns it
			const owner = innermostOwner(symbols, row + 1);
			if (!owner) continue;
			const callee = candidates[0];
			if (owner.name === callee.name && owner.occurrence === callee.occurrence) continue;
			const key = `${owner.name}#${owner.occurrence}->${callee.name}#${callee.occurrence}`;
			if (seen.has(key)) continue;
			seen.add(key);
			seenNames.add(`${owner.name}#${owner.occurrence}->${callee.name}`);
			out.push({ from: owner.name, fromOccurrence: owner.occurrence, to: callee.name, toOccurrence: callee.occurrence });
		}
	}

	// Pass 2 — bare `name(` calls; `::name(` is consumed by pass 1.
	for (const callee of symbols) {
		const re = new RegExp(`\\b${callee.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
		for (let row = 0; row < lines.length; row++) {
			re.lastIndex = 0;
			let m: RegExpExecArray | null;
			let matched = false;
			while ((m = re.exec(lines[row])) !== null) {
				if (m.index > 0 && lines[row][m.index - 1] === ":") continue; // `Type::name(` — pass 1
				matched = true;
				break;
			}
			if (!matched) continue;
			const owner = innermostOwner(symbols, row + 1);
			if (!owner || owner.name === callee.name) continue;
			const key = `${owner.name}#${owner.occurrence}->${callee.name}`;
			if (seenNames.has(key)) continue;
			seenNames.add(key);
			out.push({ from: owner.name, fromOccurrence: owner.occurrence, to: callee.name, toOccurrence: callee.occurrence });
		}
	}
	return out;
}
