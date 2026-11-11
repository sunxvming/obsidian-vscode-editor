import { App, TFile, TFolder, normalizePath } from "obsidian";
import { INCLUDE_FLAG, readCanvasTags } from "./flowchartCanvas";
import { stringifyCompact } from "./jsonCompact";

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
 * Besides member lists, a flow can be an object: `{ "members": [...] }` with
 * options (shared-code links, see flowchartAggregate.ts) or a **timeline
 * flow** `{ "layout": "timeline", ... }` laid out from an abstract
 * lanes/segments/nodes/edges description (see flowchartTimeline.ts). The
 * manifest's optional top-level `"styles"` holds named timeline style
 * presets. Membership edits only ever touch list flows' members; everything
 * else in the file is preserved (see `writeFlows`).
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
 * A flow entry as written in flows.json:
 * - `string[]` — a **list flow**: member canvases composed into
 *   `main[-<name>].canvas` (the original form);
 * - `{ "members": [...], ...options }` — a list flow with options (e.g.
 *   `"shared-links": true`, see flowchartAggregate.ts);
 * - `{ "layout": "timeline", ... }` — a **timeline flow**, laid out from an
 *   abstract description (see flowchartTimeline.ts).
 *
 * The manifest may also carry a top-level `"styles"` object: named sets of
 * timeline style keys (`default-node-size`, `default-node-spacing`, …) a
 * timeline flow picks with `"style": "<name>"`.
 */
export type FlowEntry = string[] | Record<string, any>;

export interface FlowsManifest {
	/** The parsed file (null when missing or malformed). */
	raw: Record<string, any> | null;
	flows: Record<string, FlowEntry>;
	styles: Record<string, any>;
}

/** True for entries composed from member canvases (arrays, or objects with `members` that are not timelines). */
export function isListFlow(entry: unknown): boolean {
	if (Array.isArray(entry)) return true;
	return !!entry && typeof entry === "object" && (entry as any).layout !== "timeline" && Array.isArray((entry as any).members);
}

/** A list flow's member canvas paths ([] for any other entry). */
export function flowMembers(entry: unknown): string[] {
	const list = Array.isArray(entry) ? entry : isListFlow(entry) ? (entry as any).members : [];
	return (list as unknown[]).filter((p): p is string => typeof p === "string");
}

/** Reads the whole manifest, every flow form included. Missing/malformed → empty. */
export async function readFlowsManifest(app: App, flowchartsFolder: string): Promise<FlowsManifest> {
	const empty: FlowsManifest = { raw: null, flows: {}, styles: {} };
	const file = app.vault.getAbstractFileByPath(flowsPathFor(flowchartsFolder));
	if (!(file instanceof TFile)) return empty;
	try {
		const raw = JSON.parse(await app.vault.read(file));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
		const flows = raw.flows && typeof raw.flows === "object" && !Array.isArray(raw.flows) ? raw.flows : {};
		const styles = raw.styles && typeof raw.styles === "object" && !Array.isArray(raw.styles) ? raw.styles : {};
		const out: Record<string, FlowEntry> = {};
		for (const [name, entry] of Object.entries(flows)) {
			if (Array.isArray(entry) || (entry && typeof entry === "object")) out[name] = entry as FlowEntry;
		}
		return { raw, flows: out, styles };
	} catch {
		return empty;
	}
}

/**
 * Reads the manifest's **list flows** (flow name → member canvas paths).
 * Timeline flows are left out — they have no member canvases, and the
 * "Include in flow ▸" menus must not offer them. Returns an empty record when
 * the file is missing or malformed — a missing manifest is not an error (see
 * `migrateLegacyFlagsIfNeeded`).
 */
export async function readFlows(app: App, flowchartsFolder: string): Promise<Record<string, string[]>> {
	const manifest = await readFlowsManifest(app, flowchartsFolder);
	const out: Record<string, string[]> = {};
	for (const [name, entry] of Object.entries(manifest.flows)) {
		if (isListFlow(entry)) out[name] = flowMembers(entry);
	}
	return out;
}

/**
 * Writes the manifest's list flows. Flows are sorted by name, member paths
 * deduped and sorted, and empty flows dropped (excluding the last member of a
 * flow removes the flow) — unless `opts.preserveEmptyFlows` is set, which keeps
 * empty flows in the manifest (used by `createFlow` to pre-register a flow
 * name before its first member exists). Everything else in the file is kept
 * as it is: timeline flows, the options of an object list flow (only its
 * `members` is replaced; an emptied one keeps its options), and other
 * top-level keys such as `styles`. The file is written with
 * `stringifyCompact`, so one-line nodes/edges stay one line.
 */
export async function writeFlows(
	app: App,
	flowchartsFolder: string,
	flows: Record<string, string[]>,
	opts?: { preserveEmptyFlows?: boolean },
): Promise<void> {
	const manifest = await readFlowsManifest(app, flowchartsFolder);
	const merged: Record<string, FlowEntry> = {};
	const names = new Set([...Object.keys(flows), ...Object.keys(manifest.flows)]);
	for (const name of [...names].sort()) {
		if (!name) continue;
		const existing = manifest.flows[name];
		if (existing !== undefined && !isListFlow(existing)) {
			merged[name] = existing; // timeline flows are never touched here
			continue;
		}
		const isObject = existing !== undefined && !Array.isArray(existing);
		if (!(name in flows)) {
			if (isObject) merged[name] = { ...(existing as Record<string, any>), members: [] };
			continue;
		}
		const paths = [...new Set(flows[name])].sort();
		if (isObject) {
			merged[name] = { ...(existing as Record<string, any>), members: paths };
		} else if (paths.length > 0 || opts?.preserveEmptyFlows) {
			merged[name] = paths;
		}
	}
	const content = stringifyCompact({ ...(manifest.raw ?? {}), flows: merged }, 160);
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
	const created = !(name in (await readFlowsManifest(app, flowchartsFolder)).flows);
	if (created) {
		flows[name] = [];
		await writeFlows(app, flowchartsFolder, flows, { preserveEmptyFlows: true });
	}
	return { name, created, flows };
}

/** Per-flow health report from `validateFlows`. */
export interface FlowValidation {
	name: string;
	/** `list` (member canvases) or `timeline` (laid-out nodes). */
	kind: "list" | "timeline";
	/** How many member paths the flow lists (timeline: how many nodes). */
	memberCount: number;
	/** Listed member paths that no longer exist in the vault (timeline: node `doc`/`file`/`code` paths). */
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
	const manifest = await readFlowsManifest(app, flowchartsFolder);
	const out: FlowValidation[] = [];
	const missingAll = new Set<string>();
	for (const name of Object.keys(manifest.flows).sort()) {
		const entry = manifest.flows[name];
		const missing: string[] = [];
		if (isListFlow(entry)) {
			const members = flowMembers(entry);
			for (const p of members) {
				const f = app.vault.getAbstractFileByPath(p);
				if (!(f instanceof TFile) || f.extension !== "canvas") missing.push(p);
			}
			out.push({ name, kind: "list", memberCount: members.length, missing });
		} else if (!Array.isArray(entry) && entry.layout === "timeline") {
			const nodes: any[] = Array.isArray(entry.nodes) ? entry.nodes : [];
			const paths = new Set<string>();
			if (typeof entry.doc === "string") paths.add(entry.doc);
			for (const n of nodes) {
				if (typeof n?.doc === "string") paths.add(n.doc);
				if (typeof n?.file === "string") paths.add(n.file);
				if (typeof n?.code === "string") paths.add(n.code.split("#")[0]);
			}
			for (const p of [...paths].sort()) {
				if (!(app.vault.getAbstractFileByPath(normalizePath(p)) instanceof TFile)) missing.push(p);
			}
			out.push({ name, kind: "timeline", memberCount: nodes.length, missing });
		} else {
			continue;
		}
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
