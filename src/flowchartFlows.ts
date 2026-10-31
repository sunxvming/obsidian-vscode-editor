import { App, TFile, TFolder, normalizePath } from "obsidian";
import { INCLUDE_FLAG, readCanvasTags } from "./flowchartCanvas";

/**
 * flows.json — named sets of sub-flowchart canvases ("flows").
 *
 * Every generated flowchart tree can carry a manifest at
 * `<codeRoot>/flowcharts/flows.json`:
 *
 *   { "flows": { "main": ["vault/relative.canvas", ...], "combat": [...] } }
 *
 * Each flow names the generated canvases that make up one composed flowchart;
 * "Generate aggregate flowchart from subflowchart metadata"
 * (flowchartAggregate.ts) composes each flow into
 * `<codeRoot>/flowcharts/main.canvas` (the default "main" flow) or
 * `main-<name>.canvas` (any other flow). Membership is edited via the
 * "Include in flow ▸" / "Exclude from flow ▸" menu items (flowchartMenu.ts),
 * which call `setFlowMembership` — never via canvas frontmatter. A flow name
 * can also be pre-registered before its first member exists via `createFlow`
 * (empty flows are normally dropped on write), and the manifest can be
 * health-checked without composing via `validateFlows`.
 *
 * One-time migration: the first composition run on a tree without a
 * flows.json seeds the "main" flow from canvases still tagged with the legacy
 * `includeInMainFlowchart` frontmatter tag and writes the manifest
 * (`migrateLegacyFlagsIfNeeded`). The tag itself is ignored from then on.
 */

/** The manifest's path inside a `…/flowcharts` folder. */
export function flowsPathFor(flowchartsFolder: string): string {
	return normalizePath(`${flowchartsFolder}/flows.json`);
}

/**
 * The `…/flowcharts` folder path a generated sub-flowchart canvas belongs to
 * (`…/flowcharts/Subflowcharts/…canvas`), or null for any other path.
 */
export function flowchartsFolderForPath(path: string): string | null {
	const m = path.match(/^(?:(.*)\/)?flowcharts\/Subflowcharts\//);
	return m ? `${m[1] ? `${m[1]}/` : ""}flowcharts` : null;
}

/**
 * Strips characters that are illegal in Obsidian file names (`# [ ] : | \ / ^`)
 * and trims, so a flow name is safe to embed in `main-<name>.canvas`. Returns
 * "" for names with nothing usable left — callers treat that as invalid.
 */
export function sanitizeFlowName(name: string): string {
	return name.replace(/[#:[\]|\\/^]/g, "").trim();
}

/** The composed canvas's file name: "main" keeps `main.canvas`, others get `main-<name>.canvas`. */
export function flowCanvasFileName(name: string): string {
	return name === "main" ? "main.canvas" : `main-${sanitizeFlowName(name)}.canvas`;
}

/**
 * Reads the manifest (flow name → member canvas paths). Returns an empty
 * record when the file is missing or malformed — a missing manifest is not
 * an error (see `migrateLegacyFlagsIfNeeded`).
 */
export async function readFlows(app: App, flowchartsFolder: string): Promise<Record<string, string[]>> {
	const file = app.vault.getAbstractFileByPath(flowsPathFor(flowchartsFolder));
	if (!(file instanceof TFile)) return {};
	try {
		const flows = JSON.parse(await app.vault.read(file))?.flows;
		if (!flows || typeof flows !== "object" || Array.isArray(flows)) return {};
		const out: Record<string, string[]> = {};
		for (const [name, list] of Object.entries(flows)) {
			if (!Array.isArray(list)) continue;
			out[name] = list.filter((p): p is string => typeof p === "string");
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Writes the manifest. Flows are sorted by name, member paths deduped and
 * sorted, and empty flows dropped (excluding the last member of a flow
 * removes the flow) — unless `opts.preserveEmptyFlows` is set, which keeps
 * empty flows in the manifest (used by `createFlow` to pre-register a flow
 * name before its first member exists).
 */
export async function writeFlows(
	app: App,
	flowchartsFolder: string,
	flows: Record<string, string[]>,
	opts?: { preserveEmptyFlows?: boolean },
): Promise<void> {
	const clean: Record<string, string[]> = {};
	for (const name of Object.keys(flows).sort()) {
		const paths = [...new Set(flows[name])].sort();
		if (name && (paths.length > 0 || opts?.preserveEmptyFlows)) clean[name] = paths;
	}
	const content = JSON.stringify({ flows: clean }, null, "\t");
	const existing = app.vault.getAbstractFileByPath(flowsPathFor(flowchartsFolder));
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
	} else {
		// The flowcharts folder may not exist yet when a flow is
		// pre-registered before the first generation run.
		if (!(app.vault.getAbstractFileByPath(flowchartsFolder) instanceof TFolder)) {
			await app.vault.createFolder(flowchartsFolder);
		}
		await app.vault.create(flowsPathFor(flowchartsFolder), content);
	}
}

/**
 * Adds/removes canvas paths to/from a flow and persists the manifest. The
 * flow name is sanitized; an invalid (empty-after-sanitize) name is a no-op.
 * Returns the resulting flows record (for menu caches).
 */
export async function setFlowMembership(
	app: App,
	flowchartsFolder: string,
	flowName: string,
	canvasPaths: string[],
	include: boolean,
): Promise<Record<string, string[]>> {
	const flows = await readFlows(app, flowchartsFolder);
	const name = sanitizeFlowName(flowName);
	if (!name) return flows;
	const members = new Set(flows[name] ?? []);
	for (const p of canvasPaths) {
		if (include) members.add(p);
		else members.delete(p);
	}
	flows[name] = [...members];
	await writeFlows(app, flowchartsFolder, flows);
	return flows;
}

/**
 * Pre-registers a flow name with no members yet (headless "ensure flow"):
 * the manifest keeps the empty flow (`writeFlows` would otherwise drop it),
 * so a flow name can exist before its first canvas is included. No-op when
 * the flow already exists. Returns null for an invalid (empty-after-sanitize)
 * name, otherwise `{ name, created, flows }`.
 *
 * Note: `setFlowMembership` still drops a flow when its last member is
 * removed — that is how flows get deleted. Re-call `createFlow` after such
 * an edit if the name must persist while empty.
 */
export async function createFlow(
	app: App,
	flowchartsFolder: string,
	flowName: string,
): Promise<{ name: string; created: boolean; flows: Record<string, string[]> } | null> {
	const name = sanitizeFlowName(flowName);
	if (!name) return null;
	const flows = await readFlows(app, flowchartsFolder);
	const created = !(name in flows);
	if (created) {
		flows[name] = [];
		await writeFlows(app, flowchartsFolder, flows, { preserveEmptyFlows: true });
	}
	return { name, created, flows };
}

/** Per-flow health report from `validateFlows`. */
export interface FlowValidation {
	name: string;
	/** How many member paths the flow lists. */
	memberCount: number;
	/** Listed member paths that no longer exist in the vault. */
	missing: string[];
}

/** Result of `validateFlows` for one `…/flowcharts` folder. */
export interface FlowsValidation {
	flows: FlowValidation[];
	/** Every missing member path across all flows (deduped, sorted). */
	missingCanvases: string[];
}

/**
 * Read-only manifest check: reports each flow's member paths that no longer
 * exist in the vault, without composing or rewriting anything.
 */
export async function validateFlows(app: App, flowchartsFolder: string): Promise<FlowsValidation> {
	const flows = await readFlows(app, flowchartsFolder);
	const out: FlowValidation[] = [];
	const missingAll = new Set<string>();
	for (const name of Object.keys(flows).sort()) {
		const missing: string[] = [];
		for (const p of flows[name]) {
			const f = app.vault.getAbstractFileByPath(p);
			if (!(f instanceof TFile) || f.extension !== "canvas") missing.push(p);
		}
		out.push({ name, memberCount: flows[name].length, missing });
		for (const p of missing) missingAll.add(p);
	}
	return { flows: out, missingCanvases: [...missingAll].sort() };
}

/**
 * One-time migration from the legacy `includeInMainFlowchart` frontmatter
 * tag: only when no flows.json exists yet, seeds the "main" flow from the
 * tagged canvases and writes the manifest (an empty manifest when nothing is
 * tagged, so the migration runs exactly once). Returns true when it wrote.
 */
export async function migrateLegacyFlagsIfNeeded(
	app: App,
	flowchartsFolder: string,
	subflowchartCanvases: TFile[],
): Promise<boolean> {
	if (app.vault.getAbstractFileByPath(flowsPathFor(flowchartsFolder))) return false;
	const main: string[] = [];
	for (const file of subflowchartCanvases) {
		if ((await readCanvasTags(app, file)).includes(INCLUDE_FLAG)) main.push(file.path);
	}
	await writeFlows(app, flowchartsFolder, { main });
	return true;
}
