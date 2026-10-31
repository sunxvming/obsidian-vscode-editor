import { App, TFile, TFolder } from "obsidian";
import { SymbolInfo, SymbolKind } from "./symbolResolver";
import { FlowchartFile, toSnakeCase } from "./flowchartModel";

/**
 * Cross-file Rust edge detection for the flowchart model. The per-file
 * heuristic (`detectSameFileCalls` in flowchartModel.ts) only sees calls whose
 * callee lives in the same file, so idiomatic module layouts — glob imports
 * (`use crate::player::methods::*;`) followed by bare calls, struct literals
 * and signature types from a `tables.rs`, and SpacetimeDB `ctx.db.<accessor>()`
 * table handles — produced no edges at all. This module adds them, text-based
 * like the rest of the edge heuristics (no tree-sitter queries):
 *
 * - `use` statements are parsed per file (glob, `{a, b}` lists, single names,
 *   `as` aliases; `crate::`/`super::`/`self::` resolved against the file's
 *   crate base — see `crateBaseFor` — not the scan root, so generating from a
 *   vault root above the crate still resolves `crate::…` imports) and expanded
 *   into an imported-name → target-symbol map. Glob imports expand to every
 *   edgeable symbol of the target file.
 * - `include!("…")` splices (a SpacetimeDB framework file pasted into every
 *   module crate) make the two files one namespace: the includer sees every
 *   item of the included file as if glob-imported (and `use crate::x` /
 *   `crate::x` reach them), and the included file's bare calls to functions
 *   its includers define (module hooks) are edges to each includer's
 *   function. The included file lives in every includer's crate, so its
 *   tables count as local to each of them.
 * - A mention scan flags every `\bname\b` occurrence of an imported symbol
 *   inside a symbol's line range (calls, struct literals, `Type::assoc`,
 *   signature types all mention the name). Ownership is the innermost symbol
 *   of any edgeable kind, so a struct owns the type mentions in its fields;
 *   attribute/doc lines directly above a symbol count as that symbol (this is
 *   what catches `scheduled(tick_active_consumable_effects)` in a `#[table]`
 *   attribute, which sits above the struct's own line range).
 * - A qualified-path scan resolves `crate::util::wrap(…)`,
 *   `kg_intermod::InterModuleMessage::Ping` and `axial::Axial` (through a
 *   `use kg_hex::axial;` module import): the longest module prefix that names
 *   a scanned file, then the next segment as a symbol defined or re-exported
 *   there.
 * - A `.db.<accessor>()` scan maps SpacetimeDB table handles to the struct
 *   whose `#[table(accessor = <name>, ...)]` matches. The receiver is any
 *   expression (`ctx.db`, `conn.db`, `link.conn.db`) and the chain may be
 *   split across lines the way rustfmt writes it (`ctx\n.db\n.player()`).
 *   The index covers `#[…::view(accessor = …)]` functions too (client-visible
 *   read views) and both bare (`#[table(…)`) and qualified
 *   (`#[spacetimedb::table(…)`) attributes. Only known accessors match, so
 *   unrelated `.db` fields produce nothing. What a match means depends on
 *   the consuming crate:
 *   - **Module side** (a crate that defines or includes tables, views or
 *     reducers): the accessor resolves to the table in the consumer's own
 *     crate first (two modules may define the same accessor), and the edge
 *     is `write` when the method chain after the handle mutates
 *     (`.insert(`/`.update(`/`.delete(`/… directly or through an index —
 *     `ctx.db.player().identity().update(…)`), else `read`.
 *   - **SDK consumer** (any other crate — game client, bots, relay): the
 *     generated client cache. `.on_insert(`/`.on_update(`/`.on_delete(` row
 *     callbacks are `callback` edges, anything else `read`.
 * - Other SDK consumer patterns: typed subscription queries
 *   (`global::regionQueryTableAccess::region(&q.from)`) are `subscribe` edges
 *   to the table or view; `.reducers.<name>(` and `.reducers.<name>_then(`
 *   calls are `rpc` edges to the reducer, `.reducers.on_<name>(` callbacks are
 *   `callback` edges. A consumer talks to a database through generated
 *   bindings, so when an accessor or reducer name exists in more than one
 *   module crate the bindings-module qualifier picks it: `global::…` /
 *   `region::DbConnection` in the owning function (else anywhere in the file,
 *   when only one module is named) selects the module crate whose folder has
 *   that name. Still-ambiguous sites yield no edge.
 *
 * Same-file targets are recorded only for the table-handle scan (a table
 * defined in the using file is still a table access); same-file *mentions*
 * stay with the per-file detector. Variables are neither owners nor targets
 * (a `pub const` must not become an edge endpoint). The table, reducer and
 * qualified-path scans ignore `//` comments, the mention scan reads only the
 * backticked names in them, and all scans ignore string contents.
 * Resolution limits: a name exported by two glob imports resolves
 * to the first import, and two crates exporting the same module path
 * collide first-wins. These simply yield no edge (or the first edge) when
 * they fail to resolve.
 *
 * Module-level imports are recorded separately on `FlowchartFile.importEdges`
 * (file-owned, like `.tscn` wiring — never drawn as flowchart edges). A
 * `use`/`pub use` that names an in-scope symbol but never mentions it inside
 * any declaration is still a real reference: a GDExtension `lib.rs` registers
 * every class by re-exporting it, so without this the class's own module would
 * look unused. The pointer index renders these as "imports …" only when no
 * deeper symbol-level usage exists. `include!` splices land there too
 * (`label: "include"`).
 */

/** Symbol kinds that may own or receive a cross-file edge (variables excluded). */
export const CROSS_EDGE_KINDS: Set<SymbolKind> = new Set(["function", "struct", "enum", "class", "interface"]);

/** Table-handle methods that change rows, directly or through an index. */
const WRITE_METHODS = new Set([
	"insert",
	"try_insert",
	"update",
	"try_update",
	"upsert",
	"try_upsert",
	"delete",
	"try_delete",
	"clear",
]);

/** A resolved cross-file reference: `from` (in the FlowchartFile's own file) mentions `toSym`. */
export interface CrossSymbolEdge {
	from: string;
	/** 1-based occurrence pinning `from` among same-named symbols (impl methods sharing a name). */
	fromOccurrence?: number;
	toFile: TFile;
	toSym: SymbolInfo;
	/**
	 * `read` / `write` for module-side table accesses; `read` / `callback` /
	 * `subscribe` / `rpc` for SDK consumers; unset for plain mentions.
	 */
	label?: string;
}

export interface ImportTarget {
	ff: FlowchartFile;
	sym: SymbolInfo;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Net paren balance of a line (attribute continuation detection). */
function parenDelta(s: string): number {
	let d = 0;
	for (const ch of s) {
		if (ch === "(") d++;
		else if (ch === ")") d--;
	}
	return d;
}

/** A line with its string literals emptied (quotes kept), so their contents can't match. */
function scrubStrings(line: string): string {
	return line.replace(/"([^"\\]|\\.)*"/g, '""');
}

/**
 * A string-scrubbed line for the mention scan: the code before any `//`, plus
 * only the backtick-quoted spans of the comment (`` /// Calls `send_message` ``
 * names code; `/// Admin-only` is prose).
 */
function mentionText(line: string): string {
	const cut = line.indexOf("//");
	if (cut < 0) return line;
	const quoted = line.slice(cut).match(/`[^`]*`/g) ?? [];
	return `${line.slice(0, cut)} ${quoted.join(" ")}`;
}

/** Offset just past the `)` that closes the `(` at `open` (end of text when unbalanced). */
function matchClose(code: string, open: number): number {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const ch = code[i];
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i + 1;
	}
	return code.length;
}

/**
 * Method names chained from offset `j`: `.a().b(x)` → `["a", "b"]`. Arguments
 * are skipped by paren balance and whitespace (newlines included) may sit
 * around each `.`, so rustfmt's one-call-per-line chains read the same.
 */
function chainAfter(code: string, j: number): string[] {
	const names: string[] = [];
	const link = /\s*\.\s*(\w+)\s*(?:::\s*<[^>]*>\s*)?\(/y;
	for (;;) {
		link.lastIndex = j;
		const m = link.exec(code);
		if (!m) return names;
		names.push(m[1]);
		j = matchClose(code, link.lastIndex - 1);
	}
}

/** Offsets where each line of `text` starts. */
function lineStarts(text: string): number[] {
	const out = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
	return out;
}

/** 0-based row of `offset`, given `lineStarts(text)`. */
function rowAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Vault path of `rel` resolved against the folder of `file` (`.`/`..` folded). */
function resolveRelative(file: TFile, rel: string): string {
	const segs = file.parent && file.parent.path !== "/" ? file.parent.path.split("/") : [];
	for (const s of rel.replace(/\\/g, "/").split("/")) {
		if (s === "" || s === ".") continue;
		if (s === "..") segs.pop();
		else segs.push(s);
	}
	return segs.join("/");
}

/** Folder name of a crate base (`server/modules/region/src` → `region`). */
function crateNameOf(base: string): string {
	const dir = base.endsWith("/src") ? base.slice(0, -"/src".length) : base;
	return dir.split("/").pop() ?? dir;
}

/**
 * The contiguous attribute/doc block directly above a symbol (which
 * `listSymbols` does not fold into the symbol's range), as 1-based rows.
 * Multi-line attributes are supported by tracking paren balance while walking
 * upward. Returns the rows in top-down order.
 */
export function attributeRowsAbove(lines: string[], startLine: number): number[] {
	const rows: number[] = [];
	let balance = 0; // paren balance of the partially collected attribute (walking up)
	let i = startLine - 2; // 0-based index of the line above the symbol
	while (i >= 0) {
		const t = lines[i].trim();
		const d = parenDelta(t);
		if (t.startsWith("#[")) {
			rows.unshift(i + 1);
			balance = 0; // the `#[` line closes whatever was unclosed below
			i--;
			continue;
		}
		if (t.startsWith("///")) {
			rows.unshift(i + 1);
			i--;
			continue;
		}
		if (d < 0 || balance < 0) {
			rows.unshift(i + 1);
			balance += d;
			i--;
			continue;
		}
		break;
	}
	return rows;
}

/**
 * The crate base of a Rust file: the nearest ancestor folder holding a
 * `Cargo.toml`, plus its `src` child when present. Walks all the way to the
 * vault root so generating from a folder above the crate (e.g. the vault
 * root) still finds it. Null when no `Cargo.toml` is found.
 */
function crateBaseFor(file: TFile): string | null {
	let dir = file.parent;
	while (dir) {
		const hasCargo = dir.children.some((c) => c instanceof TFile && c.name === "Cargo.toml");
		if (hasCargo) {
			const src = dir.children.find((c) => c instanceof TFolder && c.name === "src");
			return src ? `${dir.path}/src` : dir.path;
		}
		dir = dir.parent;
	}
	return null;
}

/**
 * The Rust module path of `file`, `::`-joined, relative to its crate base
 * (falling back to the scan root when no crate is found):
 * `player/tables.rs` → `player::tables`; `mod.rs`/`lib.rs`/`main.rs`
 * basenames drop, so `combat/mod.rs` → `combat` and `lib.rs` → ``.
 * The vault root's path (`"/"`) is treated as the empty prefix — Obsidian
 * file paths never start with `/`.
 */
function modulePathFor(root: TFolder, file: TFile): string | null {
	const crate = crateBaseFor(file);
	const candidates = crate ? [crate, root.path] : [root.path];
	for (let base of candidates) {
		// The vault root's path ("/") is the empty prefix — Obsidian file
		// paths never start with `/`. A file outside its crate's base (e.g.
		// outside `src/`) falls back to scan-root-relative.
		if (base === "/") base = "";
		const prefix = base === "" ? "" : `${base}/`;
		if (!file.path.startsWith(prefix)) continue;
		const segs = file.path.slice(prefix.length, file.path.length - file.extension.length - 1).split("/");
		const last = segs[segs.length - 1];
		if (last === "mod" || last === "lib" || last === "main") segs.pop();
		return segs.join("::");
	}
	return null;
}

/** Resolves a `use` path's module part against the scan root (see file header for limits). */
function resolveModPath(raw: string, selfMod: string): string | null {
	const segs = raw.split("::").filter((s) => s.length > 0);
	const selfSegs = selfMod.length > 0 ? selfMod.split("::") : [];
	let base: string[];
	let i = 0;
	if (segs[0] === "crate") {
		base = [];
		i = 1;
	} else if (segs[0] === "self") {
		base = [...selfSegs];
		i = 1;
	} else if (segs[0] === "super") {
		base = [...selfSegs];
		while (segs[i] === "super") {
			if (base.length === 0) return null; // super past the crate root
			base.pop();
			i++;
		}
	} else {
		base = []; // 2018-edition `use` paths are crate-relative
	}
	return [...base, ...segs.slice(i)].join("::");
}

interface UseImport {
	mod: string;
	/** "*" for globs, otherwise the imported names with their local alias. */
	names: "*" | { name: string; alias: string }[];
}

/**
 * Parses every `use` statement (single-line or multi-line) into a module path
 * plus imported names. Nested brace trees (`a::{b::{c}}`) are skipped entry by
 * entry. Statements that resolve outside the scanned files are dropped later,
 * at lookup time.
 */
function parseUseImports(content: string, selfMod: string): UseImport[] {
	const out: UseImport[] = [];
	const re = /^[ \t]*(?:pub[ \t]+)?use[ \t]+([^;]+);/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const body = m[1].replace(/\s*::\s*/g, "::").replace(/\s+/g, " ").trim();
		const brace = body.indexOf("{");
		let modPart: string;
		let names: UseImport["names"];
		if (body.endsWith("::*")) {
			modPart = body.slice(0, -3);
			names = "*";
		} else if (brace >= 0 && body.endsWith("}")) {
			modPart = body.slice(0, brace).replace(/::+$/, "");
			names = [];
			for (const entry of body.slice(brace + 1, -1).split(",")) {
				const e = entry.trim();
				if (!e || e.includes("{")) continue; // nested trees unsupported
				const as = e.split(/\s+as\s+/);
				names.push({ name: as[0].trim(), alias: (as[1] ?? as[0]).trim() });
			}
		} else {
			const cut = body.lastIndexOf("::");
			modPart = cut >= 0 ? body.slice(0, cut) : "";
			const tail = cut >= 0 ? body.slice(cut + 2) : body;
			const as = tail.split(/\s+as\s+/);
			names = [{ name: as[0].trim(), alias: (as[1] ?? as[0]).trim() }];
		}
		const mod = resolveModPath(modPart, selfMod);
		if (mod !== null) out.push({ mod, names });
	}
	return out;
}

/** The innermost edgeable symbol whose range contains `line` (1-based). */
function innermostSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | null {
	let best: SymbolInfo | null = null;
	for (const s of symbols) {
		if (!CROSS_EDGE_KINDS.has(s.kind)) continue;
		if (s.startLine <= line && line <= s.endLine) {
			if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
		}
	}
	return best;
}

/** Candidates with duplicates (the same defining symbol reached twice) removed. */
function distinctTargets(list: ImportTarget[]): ImportTarget[] {
	const seen = new Set<string>();
	return list.filter((t) => {
		const key = `${t.ff.file.path}#${t.sym.name}#${t.sym.occurrence}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/**
 * Fills `crossDetectedEdges` of every Rust file in `files` (see the file
 * header for the heuristics) and returns the SpacetimeDB accessor index
 * (table/view accessor name → first defining symbol) — the C# table
 * detectors in flowchartModel.ts resolve against it too. Runs after the
 * per-file scan so every file's symbols (and `reducerFns`) are known;
 * re-reads file contents via the metadata cache.
 */
export async function detectCrossFileEdges(
	app: App,
	root: TFolder,
	files: FlowchartFile[],
): Promise<Map<string, ImportTarget>> {
	const rsFiles = files.filter((ff) => ff.file.extension === "rs");
	const byPath = new Map(rsFiles.map((ff) => [ff.file.path, ff]));

	// Read every Rust file once.
	const linesByFile = new Map<FlowchartFile, string[]>();
	for (const ff of rsFiles) linesByFile.set(ff, (await app.vault.cachedRead(ff.file)).split("\n"));

	// `include!("…")` splices, resolved relative to the including file.
	const includes = new Map<FlowchartFile, FlowchartFile[]>();
	const includedBy = new Map<FlowchartFile, FlowchartFile[]>();
	const reInclude = /\binclude!\s*\(\s*"([^"]+)"\s*\)/g;
	for (const ff of rsFiles) {
		for (const line of linesByFile.get(ff)!) {
			if (/^\s*\/\//.test(line)) continue;
			reInclude.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = reInclude.exec(line)) !== null) {
				const target = byPath.get(resolveRelative(ff.file, m[1]));
				if (!target || target === ff || includes.get(ff)?.includes(target)) continue;
				pushTo(includes, ff, target);
				pushTo(includedBy, target, ff);
				ff.importEdges.push({ toFile: target.file, toSym: null, label: "include" });
			}
		}
	}

	const crateKeyCache = new Map<string, string>();
	const crateKey = (file: TFile): string => {
		let key = crateKeyCache.get(file.path);
		if (key === undefined) {
			key = crateBaseFor(file) ?? root.path;
			crateKeyCache.set(file.path, key);
		}
		return key;
	};
	/** The crates a file's items live in: an included file lives in each includer's crate. */
	const crateKeysOf = (ff: FlowchartFile): string[] => {
		const by = includedBy.get(ff);
		return by ? [...new Set(by.map((f) => crateKey(f.file)))] : [crateKey(ff.file)];
	};
	/** The module path `self`/`super` resolve against (an included file takes its first includer's). */
	const selfModOf = (ff: FlowchartFile): string | null =>
		modulePathFor(root, (includedBy.get(ff)?.[0] ?? ff).file);

	// Module path → file, for `use` resolution. Module paths are only unique
	// per crate (`kg_editor/src/ui.rs` and `kg_gdext/src/ui/mod.rs` are both
	// `ui`), so the index is keyed by the file's crate base too — otherwise the
	// first crate scanned would swallow the other's `crate::…` imports.
	const modIndex = new Map<string, FlowchartFile>();
	for (const ff of rsFiles) {
		const mod = modulePathFor(root, ff.file);
		const key = mod === null ? null : `${crateKey(ff.file)}|${mod}`;
		if (key !== null && !modIndex.has(key)) modIndex.set(key, ff);
	}
	/** The file declaring the module at `mod` in the same crate as `from`. */
	const lookupModule = (from: FlowchartFile, mod: string): FlowchartFile | undefined => {
		for (const key of crateKeysOf(from)) {
			const hit = modIndex.get(`${key}|${mod}`);
			if (hit) return hit;
		}
		return undefined;
	};

	// Crate directory name → crate base, so an import of a SIBLING in-repo crate
	// (`use kg_hex::axial::Axial;` inside kg_sim) resolves too. Without this a
	// workspace crate's folder looks consumer-free even though every other crate
	// uses it. Folder name is the crate name here (Cargo manifests are not
	// parsed); first crate wins on a name clash.
	const crateBases = new Map<string, string>();
	for (const ff of rsFiles) {
		const base = crateKey(ff.file);
		if (base === root.path) continue; // no Cargo.toml above this file
		const name = crateNameOf(base);
		if (name && !crateBases.has(name)) crateBases.set(name, base);
	}
	/** Same-crate first, then a sibling crate named by the path's first segment. */
	const lookupUse = (from: FlowchartFile, mod: string): FlowchartFile | undefined => {
		const local = lookupModule(from, mod);
		if (local) return local;
		const cut = mod.indexOf("::");
		if (cut < 0) {
			// `use kg_hex::{A, B};` — the whole path is a crate name, i.e. that
			// crate's root module (`lib.rs`, module path "").
			const rootBase = crateBases.get(mod);
			return rootBase ? modIndex.get(`${rootBase}|`) : undefined;
		}
		const externalBase = crateBases.get(mod.slice(0, cut));
		if (!externalBase) return undefined;
		return modIndex.get(`${externalBase}|${mod.slice(cut + 2)}`);
	};

	// Parse `use` statements; build the SpacetimeDB accessor index
	// (`#[table(accessor = X)]` above a struct, `#[…::view(accessor = X)]`
	// above a fn — both bare and `spacetimedb::`-qualified attributes) and the
	// reducer index; note which crates are SpacetimeDB modules.
	/** Each file's parsed `use` statements — also the re-export table (see findSymbolIn). */
	const useImportsByFile = new Map<FlowchartFile, UseImport[]>();
	const accessorIndex = new Map<string, ImportTarget>();
	const accessorCandidates = new Map<string, ImportTarget[]>();
	const reducerCandidates = new Map<string, ImportTarget[]>();
	/** Crates that define (or include) tables, views or reducers. */
	const moduleCrates = new Set<string>();
	for (const ff of rsFiles) {
		const lines = linesByFile.get(ff)!;
		const ffMod = selfModOf(ff);
		if (ffMod !== null) useImportsByFile.set(ff, parseUseImports(lines.join("\n"), ffMod));
		let isModuleFile = false;
		for (const sym of ff.symbols) {
			if (sym.kind === "function" && ff.reducerFns.has(sym.name)) {
				pushTo(reducerCandidates, sym.name, { ff, sym });
				isModuleFile = true;
			}
			if (sym.kind !== "struct" && sym.kind !== "function") continue;
			const attr = attributeRowsAbove(lines, sym.startLine)
				.map((row) => lines[row - 1])
				.join(" ");
			const isTable = sym.kind === "struct" && /\b(?:\w+::)*table\s*\(/.test(attr);
			const isView = sym.kind === "function" && /\b(?:\w+::)*view\s*\(/.test(attr);
			if (!isTable && !isView) continue;
			const m = /\baccessor\s*=\s*(\w+)/.exec(attr) ?? /\bname\s*=\s*(\w+)/.exec(attr);
			const accessor = m ? m[1] : toSnakeCase(sym.name);
			if (!accessorIndex.has(accessor)) accessorIndex.set(accessor, { ff, sym });
			pushTo(accessorCandidates, accessor, { ff, sym });
			isModuleFile = true;
		}
		if (isModuleFile) for (const key of crateKeysOf(ff)) moduleCrates.add(key);
	}
	const moduleCrateNames = new Set([...moduleCrates].map(crateNameOf));
	const isModuleSide = (ff: FlowchartFile): boolean => crateKeysOf(ff).some((k) => moduleCrates.has(k));

	/** Module-side resolution: candidates living in one of `from`'s crates, else the only candidate. */
	const moduleTargets = (from: FlowchartFile, list: ImportTarget[] | undefined): ImportTarget[] => {
		if (!list) return [];
		const all = distinctTargets(list);
		const keys = new Set(crateKeysOf(from));
		const local = all.filter((t) => crateKeysOf(t.ff).some((k) => keys.has(k)));
		if (local.length > 0) return local;
		return all.length === 1 ? all : [];
	};
	/**
	 * SDK-consumer resolution: the only candidate, else the one in the module
	 * crate the bindings qualifier names. Null when still ambiguous.
	 */
	const sdkTarget = (list: ImportTarget[] | undefined, qualifier: string | null): ImportTarget | null => {
		if (!list) return null;
		const all = distinctTargets(list);
		if (all.length === 1) return all[0];
		if (!qualifier) return null;
		return all.find((t) => crateKeysOf(t.ff).some((k) => crateNameOf(k) === qualifier)) ?? null;
	};

	/**
	 * The defining symbol `name` reachable from module `target`: defined there,
	 * spliced in by an `include!`, or re-exported (`pub use small::SmallHex;`)
	 * and therefore defined in a submodule — the idiom that makes
	 * `use kg_hex::{SmallHex, Torus};` work in Rust, where the crate root only
	 * re-exports. Follows one chain up to 3 hops, cycle-guarded.
	 */
	const findSymbolIn = (target: FlowchartFile, name: string, depth = 0): ImportTarget | null => {
		const own = target.symbols.find((s) => s.name === name && CROSS_EDGE_KINDS.has(s.kind));
		if (own) return { ff: target, sym: own };
		for (const inc of includes.get(target) ?? []) {
			const spliced = inc.symbols.find((s) => s.name === name && CROSS_EDGE_KINDS.has(s.kind));
			if (spliced) return { ff: inc, sym: spliced };
		}
		if (depth >= 3) return null;
		for (const imp of useImportsByFile.get(target) ?? []) {
			if (imp.names === "*") {
				const next = lookupUse(target, imp.mod);
				if (!next || next === target) continue;
				const found = findSymbolIn(next, name, depth + 1);
				if (found) return found;
				continue;
			}
			const hit = imp.names.find((n) => n.alias === name || n.name === name);
			if (!hit) continue;
			const next = lookupUse(target, imp.mod);
			if (!next || next === target) continue;
			const found = findSymbolIn(next, hit.name, depth + 1);
			if (found) return found;
		}
		return null;
	};

	/** Every symbol a `use M::*;` brings in, following includes and re-exports (cycle-guarded). */
	const symbolsOfModule = (
		target: FlowchartFile,
		depth = 0,
		seen = new Set<FlowchartFile>(),
	): ImportTarget[] => {
		if (seen.has(target) || depth > 3) return [];
		seen.add(target);
		const out: ImportTarget[] = [];
		for (const ff of [target, ...(includes.get(target) ?? [])]) {
			for (const sym of ff.symbols) if (CROSS_EDGE_KINDS.has(sym.kind)) out.push({ ff, sym });
		}
		for (const imp of useImportsByFile.get(target) ?? []) {
			const next = lookupUse(target, imp.mod);
			if (!next || next === target) continue;
			if (imp.names === "*") {
				out.push(...symbolsOfModule(next, depth + 1, seen));
				continue;
			}
			for (const n of imp.names) {
				const found = findSymbolIn(next, n.name, depth + 1);
				if (found) out.push(found);
			}
		}
		return out;
	};

	for (const ff of rsFiles) {
		const lines = linesByFile.get(ff)!;
		const selfMod = selfModOf(ff);
		if (selfMod === null) continue;

		// Imported-name → target symbols. Locally defined names shadow
		// imports; between two imports the first one wins.
		const localNames = new Set(ff.symbols.map((s) => s.name));
		const imported = new Map<string, ImportTarget[]>();
		/** `use`-bound name → the module path it names (`use kg_hex::axial;` → `kg_hex::axial`). */
		const useAliases = new Map<string, string>();
		const importSeen = new Set<string>();
		for (const imp of useImportsByFile.get(ff) ?? []) {
			if (imp.names !== "*") {
				for (const { name, alias } of imp.names) {
					if (!useAliases.has(alias)) useAliases.set(alias, imp.mod ? `${imp.mod}::${name}` : name);
				}
			}
			const target = lookupUse(ff, imp.mod);
			if (!target) continue;
			if (imp.names === "*") {
				for (const found of symbolsOfModule(target)) {
					const { sym } = found;
					if (localNames.has(sym.name) || imported.has(sym.name)) continue;
					imported.set(sym.name, [found]);
				}
			} else {
				for (const { name, alias } of imp.names) {
					if (localNames.has(alias) || imported.has(alias)) continue;
					const found = findSymbolIn(target, name);
					if (!found) continue;
					imported.set(alias, [found]);
					// Module-level `use`/`pub use` of another file's symbol is a
					// real reference even when the name never appears inside a
					// declaration (GDExtension `lib.rs` re-export hubs). Recorded
					// as a file-owned edge for the pointer index only.
					if (found.ff === ff) continue;
					const key = `${found.ff.file.path}#${found.sym.name}`;
					if (importSeen.has(key)) continue;
					importSeen.add(key);
					ff.importEdges.push({ toFile: found.ff.file, toSym: found.sym, label: "import" });
				}
			}
		}
		// An includer sees every item of the files it splices in.
		for (const inc of includes.get(ff) ?? []) {
			for (const sym of inc.symbols) {
				if (!CROSS_EDGE_KINDS.has(sym.kind) || localNames.has(sym.name) || imported.has(sym.name)) continue;
				imported.set(sym.name, [{ ff: inc, sym }]);
			}
		}

		// `mod <name>;` declarations — `lib.rs`/parent `mod.rs` pointing at a
		// child module file. Not a symbol reference, but the child module's own
		// file (and its `mod.rs`) is only reachable through it.
		const reModDecl = /^[ \t]*(?:pub[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm;
		const joined = lines.join("\n");
		let modDecl: RegExpExecArray | null;
		while ((modDecl = reModDecl.exec(joined)) !== null) {
			const childMod = selfMod.length > 0 ? `${selfMod}::${modDecl[1]}` : modDecl[1];
			const target = lookupModule(ff, childMod);
			if (!target || target === ff) continue;
			const key = `${target.file.path}#`;
			if (importSeen.has(key)) continue;
			importSeen.add(key);
			ff.importEdges.push({ toFile: target.file, toSym: null, label: "declare module" });
		}

		// Attribute/doc lines directly above a symbol are owned by that symbol
		// (catches `scheduled(fn_name)` in `#[table(...)]` and doc mentions).
		const attrOwner = new Map<number, SymbolInfo>();
		for (const sym of ff.symbols) {
			if (!CROSS_EDGE_KINDS.has(sym.kind)) continue;
			for (const row of attributeRowsAbove(lines, sym.startLine)) {
				if (!attrOwner.has(row)) attrOwner.set(row, sym);
			}
		}

		const seen = new Set<string>();
		const pushEdge = (owner: SymbolInfo, target: ImportTarget, label?: string, allowSameFile = false) => {
			if (!allowSameFile && target.ff === ff) return; // same-file mentions stay with the per-file detector
			const key = `${owner.name}#${owner.occurrence}->${target.ff.file.path}#${target.sym.name}#${target.sym.occurrence}:${label ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
			ff.crossDetectedEdges.push({
				from: owner.name,
				fromOccurrence: owner.occurrence,
				toFile: target.ff.file,
				toSym: target.sym,
				label,
			});
		};
		const ownerAt = (row: number): SymbolInfo | null =>
			innermostSymbol(ff.symbols, row) ?? attrOwner.get(row) ?? null;

		// Scans run on string-scrubbed lines so `format!("Enchantment ...")`
		// and friends can't produce phantom mentions. The mention scan keeps
		// the backticked names in comments (doc lines above a symbol are owned
		// by it); the code scans below drop comments and run over the joined
		// text, offsets mapped back to rows, so chains split across lines
		// still match.
		const scrubbed = lines.map((l) => mentionText(scrubStrings(l)));
		const codeLines = lines.map((l) => scrubStrings(l).replace(/\/\/.*$/, ""));
		const code = codeLines.join("\n");
		const starts = lineStarts(code);

		// Mention scan: any occurrence of an imported name (calls, struct
		// literals, `Type::assoc`, signature types) inside a symbol's range.
		const names = [...imported.keys()];
		if (names.length > 0) {
			const re = new RegExp(`\\b(${names.map(escapeRegExp).join("|")})\\b`, "g");
			for (let row = 0; row < scrubbed.length; row++) {
				const line = scrubbed[row];
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(line)) !== null) {
					// Skip look-alikes that only share the name: member accesses
					// (`.is_admin`) and struct-literal fields (`is_admin:`).
					if (m.index > 0 && line[m.index - 1] === ".") continue;
					if (line.startsWith(":", m.index + m[1].length) && !line.startsWith("::", m.index + m[1].length)) continue;
					const owner = ownerAt(row + 1);
					if (owner) for (const t of imported.get(m[1])!) pushEdge(owner, t);
				}
			}
		}

		// Qualified paths: the longest module prefix that names a scanned file,
		// then the next segment as a symbol defined or re-exported there. Heads
		// that are local or imported names are the other scans' business.
		const rePath = /(?<![\w:])\w+(?:\s*::\s*\w+)+/g;
		for (let row = 0; row < codeLines.length; row++) {
			const line = codeLines[row];
			if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\b/.test(line)) continue;
			rePath.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = rePath.exec(line)) !== null) {
				const segs = m[0].split(/\s*::\s*/);
				const head = segs[0];
				if (head === "Self" || localNames.has(head) || imported.has(head)) continue;
				const owner = ownerAt(row + 1);
				if (!owner) continue;
				const alias = useAliases.get(head);
				const resolved = alias !== undefined ? [...alias.split("::"), ...segs.slice(1)] : segs;
				const offset = resolved.length - segs.length; // segments the alias expanded into
				for (let k = resolved.length - 1; k >= 1 + Math.max(0, offset); k--) {
					const prefix = resolved.slice(0, k).join("::");
					const modPath = alias !== undefined ? prefix : resolveModPath(prefix, selfMod);
					if (modPath === null) break;
					const file = lookupUse(ff, modPath);
					if (!file) continue;
					const found = findSymbolIn(file, resolved[k]);
					if (!found) continue;
					pushEdge(owner, found);
					break;
				}
			}
		}

		// An included file calls back into the files that include it (module
		// hooks such as `handle_message(…)`, defined by every module that
		// splices the framework in): each includer's function of that name.
		const includers = includedBy.get(ff) ?? [];
		if (includers.length > 0) {
			const hooks = new Map<string, ImportTarget[]>();
			for (const inc of includers) {
				for (const sym of inc.symbols) {
					if (sym.kind === "function" && !localNames.has(sym.name)) pushTo(hooks, sym.name, { ff: inc, sym });
				}
			}
			const reCall = /(?<![\w.:])(\w+)\s*\(/g;
			let m: RegExpExecArray | null;
			while ((m = reCall.exec(code)) !== null) {
				const targets = hooks.get(m[1]);
				if (!targets) continue;
				const owner = ownerAt(rowAt(starts, m.index) + 1);
				if (owner) for (const t of targets) pushEdge(owner, t);
			}
		}

		// The generated-bindings module an SDK consumer site talks to: the one
		// module crate named in the owning symbol (`region::DbConnection`),
		// else the one named anywhere in the file.
		const qualifiersIn = (from: number, to: number): Set<string> => {
			const out = new Set<string>();
			const re = /(?<![\w:])(\w+)\s*::/g;
			for (let r = Math.max(0, from); r <= to && r < codeLines.length; r++) {
				re.lastIndex = 0;
				let q: RegExpExecArray | null;
				while ((q = re.exec(codeLines[r])) !== null) if (moduleCrateNames.has(q[1])) out.add(q[1]);
			}
			return out;
		};
		let fileQualifier: string | null | undefined;
		const ownerQualifiers = new Map<string, string | null>();
		const qualifierFor = (owner: SymbolInfo): string | null => {
			const key = `${owner.name}#${owner.occurrence}`;
			const cached = ownerQualifiers.get(key);
			if (cached !== undefined) return cached;
			const own = qualifiersIn(owner.startLine - 1, owner.endLine - 1);
			let q: string | null;
			if (own.size > 0) q = own.size === 1 ? [...own][0] : null;
			else {
				if (fileQualifier === undefined) {
					const all = qualifiersIn(0, codeLines.length - 1);
					fileQualifier = all.size === 1 ? [...all][0] : null;
				}
				q = fileQualifier;
			}
			ownerQualifiers.set(key, q);
			return q;
		};

		// SpacetimeDB table handles: `<receiver>.db.<accessor>()` → the
		// accessor's struct (or view fn). Same-file tables are recorded here —
		// the per-file detector only sees plain calls.
		const moduleSide = isModuleSide(ff);
		const reDb = /\.\s*db\s*\.\s*(\w+)\s*\(\s*\)/g;
		let m: RegExpExecArray | null;
		while ((m = reDb.exec(code)) !== null) {
			const list = accessorCandidates.get(m[1]);
			if (!list) continue;
			const owner = ownerAt(rowAt(starts, m.index) + 1);
			if (!owner) continue;
			const chain = chainAfter(code, m.index + m[0].length);
			if (moduleSide) {
				const label = chain.some((c) => WRITE_METHODS.has(c)) ? "write" : "read";
				for (const t of moduleTargets(ff, list)) pushEdge(owner, t, label, true);
			} else {
				const target = sdkTarget(list, qualifierFor(owner));
				const callback = chain.length > 0 && /^on_(insert|update|delete)$/.test(chain[0]);
				if (target) pushEdge(owner, target, callback ? "callback" : "read");
			}
		}
		if (moduleSide) continue;

		// SDK reducer calls: `.reducers.<name>(` / `.reducers.<name>_then(`
		// call it, `.reducers.on_<name>(` registers a result callback.
		const reReducer = /\.\s*reducers\s*\.\s*(\w+)\s*\(/g;
		while ((m = reReducer.exec(code)) !== null) {
			let name = m[1];
			let label = "rpc";
			if (!reducerCandidates.has(name)) {
				if (name.endsWith("_then")) name = name.slice(0, -"_then".length);
				else if (name.startsWith("on_")) {
					name = name.slice("on_".length);
					label = "callback";
				}
			}
			const owner = ownerAt(rowAt(starts, m.index) + 1);
			if (!owner) continue;
			const target = sdkTarget(reducerCandidates.get(name), qualifierFor(owner));
			if (target) pushEdge(owner, target, label);
		}

		// Typed subscription queries: `<bindings>::<accessor>QueryTableAccess::<accessor>(&q.from)`.
		const reQuery = /\b(\w+)\s*::\s*\w+?QueryTableAccess\s*::\s*(\w+)/g;
		while ((m = reQuery.exec(code)) !== null) {
			const owner = ownerAt(rowAt(starts, m.index) + 1);
			if (!owner) continue;
			const qualifier = moduleCrateNames.has(m[1]) ? m[1] : qualifierFor(owner);
			const target = sdkTarget(accessorCandidates.get(m[2]), qualifier);
			if (target) pushEdge(owner, target, "subscribe");
		}
	}

	return accessorIndex;
}
