import { TFile, TFolder } from "obsidian";
import { FlowchartModel, toSnakeCase } from "./flowchartModel";
import { SymbolInfo } from "./symbolResolver";

/**
 * Consumer collection for the generated pointer files (see pointerFiles.ts).
 * Pure read-only logic over a vault-rooted FlowchartModel: for a target
 * folder, find every code file OUTSIDE the folder whose detected edges land
 * on a file INSIDE it, and phrase each hit as a `PointerUsage`
 * (consumer -> target, with a verb and the symbol/accessor involved).
 *
 * Edge sources (all built by buildFlowchartModel):
 * - `crossDetectedEdges` — Rust cross-file mentions (`uses`), module-side
 *   `ctx.db` table accesses (`reads`/`writes`), Rust SDK consumers (`reads`
 *   the client cache, `registers callbacks on` tables and reducers,
 *   `subscribes to`, `calls reducer`), C# table-name strings
 *   (`subscribes to`).
 * - `detectedEdges` — C# `Reducers.X(...)` (`calls reducer`, resolved through
 *   `reducerIndex`) and `.Db.X` reads (`reads table`, via `accessorIndex`).
 *   Bare-name AutoEdges are same-file only and never cross the folder
 *   boundary, so they are skipped.
 * - `fileEdges` — `.tscn` wiring: attached scripts, instanced scenes, and
 *   `TableName` binds.
 * - `importEdges` — module-level `use` (`imports`), `mod x;` (`declares
 *   module`) and `include!` splices (`includes`), as a fallback.
 *
 * Scenes get one hop of transitivity: a `.tscn` that attaches a script also
 * inherits that script's folder-targeting usages, marked `via` the script —
 * this is what lets `local_player.tscn` show "calls reducers
 * `report_movement` ... (via PositionSyncComponent.cs)". The script keeps its
 * own direct entry as well.
 */

export interface PointerUsage {
	/** The outside file that uses the folder's code. */
	consumer: TFile;
	/** The owning symbol inside the consumer file; null = whole-file usage (`.tscn` wiring, scenes). */
	consumerSym: SymbolInfo | null;
	/** The file inside the target folder being used. */
	target: TFile;
	/** The targeted symbol inside the target file; null = whole-file target (scene/instance edges, symbol-less files). */
	targetSym: SymbolInfo | null;
	/** `calls reducer` / `reads table` / `reads` / `writes` / `subscribes to` / `registers callbacks on` / `uses` / `binds` / `attaches script` / `instances scene` / `includes`. */
	verb: string;
	/** The reducer fn, accessor, or symbol name involved. */
	name: string;
	/** Set when the usage is inherited from a scene's attached script. */
	via?: TFile;
	/** The script-side symbol the inherited scene usage flows through (symbol granularity only). */
	viaSym?: SymbolInfo | null;
}

/** Nested indexes over a usage list: by target file then consumer, and vice versa. */
export interface PointerUsageIndex {
	byTarget: Map<string, Map<string, PointerUsage[]>>;
	byConsumer: Map<string, Map<string, PointerUsage[]>>;
}

function isUnder(file: TFile, folder: TFolder): boolean {
	if (folder.path === "/") return true;
	return file.path === folder.path || file.path.startsWith(`${folder.path}/`);
}

/** Resolve an edge owner name (+optional occurrence) to its SymbolInfo in the consumer file. */
function findOwnerSymbol(symbols: SymbolInfo[], name: string, occurrence?: number): SymbolInfo | null {
	if (occurrence != null) {
		const exact = symbols.find((s) => s.name === name && s.occurrence === occurrence);
		if (exact) return exact;
	}
	return symbols.find((s) => s.name === name) ?? null;
}

/** Pointer verb for each `crossDetectedEdges` label; unlabeled mentions are `uses`. */
const CROSS_EDGE_VERBS: Record<string, string> = {
	read: "reads",
	write: "writes",
	subscribe: "subscribes to",
	rpc: "calls reducer",
	callback: "registers callbacks on",
};

/** Module name a file declares: `player/mod.rs` → `player`, `geo.rs` → `geo`. */
function moduleNameOf(file: TFile): string {
	return file.basename === "mod" ? file.parent?.name ?? file.basename : file.basename;
}

export function collectPointerUsage(model: FlowchartModel, target: TFolder): PointerUsage[] {
	const inTarget = (f: TFile) => isUnder(f, target) && f.path !== target.path;
	const byPath = new Map(model.files.map((ff) => [ff.file.path, ff]));

	// Direct usages, grouped by consumer path so the scene pass can look up a
	// script's own usages without rescanning.
	const direct = new Map<string, PointerUsage[]>();
	/** Import-only usages, applied at the end when no deeper usage covers them. */
	const pendingImports: PointerUsage[] = [];
	const seen = new Set<string>();
	const symKey = (s: SymbolInfo | null | undefined): string =>
		s ? `${s.name}#${s.occurrence}` : "";
	const push = (u: PointerUsage, into?: Map<string, PointerUsage[]>) => {
		// Symbol identities are part of the key so two owners using the same
		// target name stay distinct for symbol granularity; file-level
		// rendering re-groups by verb+name and is unaffected.
		const key =
			`${u.consumer.path}|${symKey(u.consumerSym)}|${u.target.path}|${symKey(u.targetSym)}|` +
			`${u.verb}|${u.name}|${u.via?.path ?? ""}|${symKey(u.viaSym)}`;
		if (seen.has(key)) return;
		seen.add(key);
		const list = into ?? direct;
		const group = list.get(u.consumer.path) ?? [];
		group.push(u);
		list.set(u.consumer.path, group);
	};

	for (const ff of model.files) {
		if (inTarget(ff.file)) continue;

		for (const e of ff.crossDetectedEdges) {
			if (!inTarget(e.toFile)) continue;
			const verb = (e.label && CROSS_EDGE_VERBS[e.label]) || "uses";
			push({
				consumer: ff.file,
				consumerSym: findOwnerSymbol(ff.symbols, e.from, e.fromOccurrence),
				target: e.toFile,
				targetSym: e.toSym,
				verb,
				name: e.toSym.name,
			});
		}

		for (const e of ff.detectedEdges) {
			if (e.to.startsWith("reducer:")) {
				const name = e.to.slice("reducer:".length);
				const t = model.reducerIndex.get(name);
				if (t && inTarget(t.file)) {
					const targetFf = byPath.get(t.file.path);
					const targetSym =
						targetFf?.symbols.find((s) => s.kind === "function" && s.name === t.fnName) ?? null;
					push({
						consumer: ff.file,
						consumerSym: findOwnerSymbol(ff.symbols, e.from, e.fromOccurrence),
						target: t.file,
						targetSym,
						verb: "calls reducer",
						name: t.fnName,
					});
				}
			} else if (e.to.startsWith("table:")) {
				const name = toSnakeCase(e.to.slice("table:".length));
				const t = model.accessorIndex.get(name);
				if (t && inTarget(t.ff.file)) {
					push({
						consumer: ff.file,
						consumerSym: findOwnerSymbol(ff.symbols, e.from, e.fromOccurrence),
						target: t.ff.file,
						targetSym: t.sym,
						verb: "reads table",
						name,
					});
				}
			}
			// Bare-name AutoEdges are same-file calls - never cross-folder.
		}

		for (const e of ff.fileEdges) {
			if (!inTarget(e.toFile)) continue;
			const verb =
				e.label === "script"
					? "attaches script"
					: e.label === "scene"
						? "instances scene"
						: e.label === "class"
							? "instantiates class"
							: "binds";
			push({
				consumer: ff.file,
				consumerSym: null,
				target: e.toFile,
				targetSym: e.toSym,
				verb,
				name: e.toSym?.name ?? e.toFile.basename,
			});
		}

		// Module-level `use`/`pub use` of another file's symbol, `mod x;`
		// declarations and `include!` splices (whole-file references, no owning
		// symbol). Kept aside: a file that also mentions the symbol inside a
		// declaration should read as one usage, not two.
		for (const e of ff.importEdges) {
			if (!inTarget(e.toFile)) continue;
			const isModuleDecl = e.label === "declare module";
			pendingImports.push({
				consumer: ff.file,
				consumerSym: null,
				target: e.toFile,
				targetSym: e.toSym,
				verb: isModuleDecl ? "declares module" : e.label === "include" ? "includes" : "imports",
				name: isModuleDecl ? moduleNameOf(e.toFile) : e.toSym?.name ?? e.toFile.name,
			});
		}
	}

	// Drop the import fallback where the same file already uses the same target
	// symbol for real (that deeper usage is the more useful entry).
	const covered = new Set<string>();
	for (const list of direct.values()) {
		for (const u of list) covered.add(`${u.consumer.path}|${u.target.path}|${symKey(u.targetSym)}`);
	}
	for (const u of pendingImports) {
		if (covered.has(`${u.consumer.path}|${u.target.path}|${symKey(u.targetSym)}`)) continue;
		push(u);
	}

	// Scene transitivity: a scene inherits the folder-targeting usages of its
	// attached scripts, marked `via` the script.
	const all = new Map<string, PointerUsage[]>();
	for (const [path, list] of direct) all.set(path, [...list]);
	for (const ff of model.files) {
		if (ff.file.extension !== "tscn" || inTarget(ff.file)) continue;
		for (const e of ff.fileEdges) {
			if (e.label !== "script") continue;
			const scriptUsages = direct.get(e.toFile.path);
			if (!scriptUsages) continue;
			for (const u of scriptUsages) {
				push(
					{
						consumer: ff.file,
						consumerSym: null,
						target: u.target,
						targetSym: u.targetSym,
						verb: u.verb,
						name: u.name,
						via: e.toFile,
						viaSym: u.consumerSym,
					},
					all,
				);
			}
		}
	}

	const out: PointerUsage[] = [];
	for (const list of all.values()) out.push(...list);
	return out;
}

export function indexPointerUsage(usages: PointerUsage[]): PointerUsageIndex {
	const byTarget: PointerUsageIndex["byTarget"] = new Map();
	const byConsumer: PointerUsageIndex["byConsumer"] = new Map();
	for (const u of usages) {
		let consumers = byTarget.get(u.target.path);
		if (!consumers) byTarget.set(u.target.path, (consumers = new Map()));
		let list = consumers.get(u.consumer.path);
		if (!list) consumers.set(u.consumer.path, (list = []));
		list.push(u);

		let targets = byConsumer.get(u.consumer.path);
		if (!targets) byConsumer.set(u.consumer.path, (targets = new Map()));
		let list2 = targets.get(u.target.path);
		if (!list2) targets.set(u.target.path, (list2 = []));
		list2.push(u);
	}
	return { byTarget, byConsumer };
}
