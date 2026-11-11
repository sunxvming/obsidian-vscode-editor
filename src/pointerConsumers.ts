import { TFile } from "obsidian";
import { FlowchartModel, toSnakeCase } from "./flowchartModel";
import { SymbolInfo } from "./symbolResolver";

/**
 * Usage collection for the generated pointer files (see pointerFiles.ts).
 * Pure read-only logic over a vault-rooted FlowchartModel: every detected
 * reference from one code file to another, phrased as a `PointerUsage`
 * (consumer -> target, with a verb and the symbol/accessor involved). The
 * whole vault is collected in ONE pass (`collectVaultUsages`); each pointer
 * file then keeps the usages that cross its own boundary (`usagesInto`,
 * `usagesOutOf`).
 *
 * Edge sources (all built by buildFlowchartModel):
 * - `crossDetectedEdges` — Rust cross-file mentions (`uses`), module-side
 *   `ctx.db` table accesses (`reads`/`writes`), Rust SDK consumers (`reads`
 *   the client cache, `registers callbacks on` tables and reducers,
 *   `subscribes to`, `calls reducer`), C# table-name strings
 *   (`subscribes to`).
 * - `detectedEdges` — C# `Reducers.X(...)` (`calls reducer`, resolved through
 *   `reducerIndex`) and `.Db.X` reads (`reads table`, via `accessorIndex`).
 *   Bare-name AutoEdges are same-file only and are skipped.
 * - `fileEdges` — `.tscn` wiring: attached scripts, instanced scenes, and
 *   `TableName` binds.
 * - `importEdges` — module-level `use` (`imports`), `mod x;` (`declares
 *   module`) and `include!` splices (`includes`), as a fallback: dropped
 *   where the same file already uses the same target symbol for real.
 *
 * Scenes get one hop of transitivity: a `.tscn` that attaches a script also
 * inherits that script's usages, marked `via` the script — this is what lets
 * `local_player.tscn` show "calls reducers `report_movement` ... (via
 * PositionSyncComponent.cs)". The script keeps its own direct entry as well.
 * A file's references to itself are never usages.
 */

export interface PointerUsage {
	/** The file that uses the target's code. */
	consumer: TFile;
	/** The owning symbol inside the consumer file; null = whole-file usage (`.tscn` wiring, imports). */
	consumerSym: SymbolInfo | null;
	/** The file being used. */
	target: TFile;
	/** The targeted symbol inside the target file; null = whole-file target (scene/instance edges, symbol-less files). */
	targetSym: SymbolInfo | null;
	/** `calls reducer` / `reads table` / `reads` / `writes` / `subscribes to` / `registers callbacks on` / `uses` / `binds` / `attaches script` / `instances scene` / `instantiates class` / `imports` / `declares module` / `includes`. */
	verb: string;
	/** The reducer fn, accessor, or symbol name involved. */
	name: string;
	/** Set when the usage is inherited from a scene's attached script. */
	via?: TFile;
	/** The script-side symbol the inherited scene usage flows through. */
	viaSym?: SymbolInfo | null;
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

/** Identity key for a symbol (`name#occurrence`, "" for whole-file). */
export function symbolKey(s: SymbolInfo | null | undefined): string {
	return s ? `${s.name}#${s.occurrence}` : "";
}

/** Every cross-file usage in the model (see the module doc). */
export function collectVaultUsages(model: FlowchartModel): PointerUsage[] {
	const byPath = new Map(model.files.map((ff) => [ff.file.path, ff]));

	/** Direct usages grouped by consumer path, for the scene pass. */
	const direct = new Map<string, PointerUsage[]>();
	const pendingImports: PointerUsage[] = [];
	const seen = new Set<string>();
	const keyOf = (u: PointerUsage) =>
		`${u.consumer.path}|${symbolKey(u.consumerSym)}|${u.target.path}|${symbolKey(u.targetSym)}|` +
		`${u.verb}|${u.name}|${u.via?.path ?? ""}|${symbolKey(u.viaSym)}`;
	const out: PointerUsage[] = [];
	const push = (u: PointerUsage, isDirect: boolean) => {
		if (u.consumer.path === u.target.path) return;
		const key = keyOf(u);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(u);
		if (!isDirect) return;
		const group = direct.get(u.consumer.path) ?? [];
		group.push(u);
		direct.set(u.consumer.path, group);
	};

	for (const ff of model.files) {
		for (const e of ff.crossDetectedEdges) {
			push(
				{
					consumer: ff.file,
					consumerSym: findOwnerSymbol(ff.symbols, e.from, e.fromOccurrence),
					target: e.toFile,
					targetSym: e.toSym,
					verb: (e.label && CROSS_EDGE_VERBS[e.label]) || "uses",
					name: e.toSym.name,
				},
				true,
			);
		}

		for (const e of ff.detectedEdges) {
			if (e.to.startsWith("reducer:")) {
				const t = model.reducerIndex.get(e.to.slice("reducer:".length));
				if (!t) continue;
				const targetSym =
					byPath.get(t.file.path)?.symbols.find((s) => s.kind === "function" && s.name === t.fnName) ?? null;
				push(
					{
						consumer: ff.file,
						consumerSym: findOwnerSymbol(ff.symbols, e.from, e.fromOccurrence),
						target: t.file,
						targetSym,
						verb: "calls reducer",
						name: t.fnName,
					},
					true,
				);
			} else if (e.to.startsWith("table:")) {
				const name = toSnakeCase(e.to.slice("table:".length));
				const t = model.accessorIndex.get(name);
				if (!t) continue;
				push(
					{
						consumer: ff.file,
						consumerSym: findOwnerSymbol(ff.symbols, e.from, e.fromOccurrence),
						target: t.ff.file,
						targetSym: t.sym,
						verb: "reads table",
						name,
					},
					true,
				);
			}
			// Bare-name AutoEdges are same-file calls - never cross-file.
		}

		for (const e of ff.fileEdges) {
			const verb =
				e.label === "script"
					? "attaches script"
					: e.label === "scene"
						? "instances scene"
						: e.label === "class"
							? "instantiates class"
							: "binds";
			push(
				{
					consumer: ff.file,
					consumerSym: null,
					target: e.toFile,
					targetSym: e.toSym,
					verb,
					name: e.toSym?.name ?? e.toFile.basename,
				},
				true,
			);
		}

		// Module-level `use`/`pub use`, `mod x;` and `include!` (whole-file
		// references, no owning symbol). Kept aside: a file that also
		// mentions the symbol inside a declaration should read as one usage.
		for (const e of ff.importEdges) {
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

	// The import fallback only where the same file has no deeper usage of the
	// same target symbol.
	const covered = new Set<string>();
	for (const u of out) covered.add(`${u.consumer.path}|${u.target.path}|${symbolKey(u.targetSym)}`);
	for (const u of pendingImports) {
		if (!covered.has(`${u.consumer.path}|${u.target.path}|${symbolKey(u.targetSym)}`)) push(u, true);
	}

	// Scene transitivity: a scene inherits its attached scripts' usages.
	for (const ff of model.files) {
		if (ff.file.extension !== "tscn") continue;
		for (const e of ff.fileEdges) {
			if (e.label !== "script") continue;
			for (const u of direct.get(e.toFile.path) ?? []) {
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
					false,
				);
			}
		}
	}
	return out;
}

/**
 * The usages of a pointer file's code from outside it: target inside, consumer
 * outside (and, for a scene's inherited usage, the attached script outside
 * too — a scene reaching the code through a script that lives inside is
 * already listed via its own `attaches script` edge).
 */
export function usagesInto(all: PointerUsage[], isInside: (path: string) => boolean): PointerUsage[] {
	return all.filter(
		(u) => isInside(u.target.path) && !isInside(u.consumer.path) && !(u.via && isInside(u.via.path)),
	);
}

/** The usages a pointer file's own code makes of `accept`ed code outside it (inherited scene usages excluded). */
export function usagesOutOf(
	all: PointerUsage[],
	isInside: (path: string) => boolean,
	accept: (u: PointerUsage) => boolean,
): PointerUsage[] {
	return all.filter((u) => !u.via && isInside(u.consumer.path) && !isInside(u.target.path) && accept(u));
}
