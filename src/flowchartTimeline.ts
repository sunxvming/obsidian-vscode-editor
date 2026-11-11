import { App, TFile, normalizePath } from "obsidian";
import { writeCanvas } from "./flowchartCanvas";
import {
	CodeIndex,
	DerivedLink,
	LinkKind,
	LinkNode,
	deriveLinks,
	docSectionCodeIdentities,
	identityOf,
} from "./flowchartCodeLinks";
import { CodeSide, parseCodeSides, sideOf } from "./flowchartSides";

/**
 * Timeline flows — a flows.json flow that describes a left-to-right sequence
 * chart abstractly and is laid out by the plugin, instead of a hand-placed
 * canvas. The shape is the house "bespoke flowchart" style
 * (`.claude/skills/bespoke-flowcharts`): swim lanes stacked top to bottom
 * (**timeline groups**: Server Table, Relay, Player Client 1, …), chapters
 * left to right (**timeline segments**: "Spawning and observing", …), a white
 * main path on each lane's top row, coloured **forks** below it, and
 * **clusters** boxing a run of main-path cards.
 *
 * Nobody places a card. A card names its lane (`group`), chapter (`segment`)
 * and, optionally, its fork or cluster; its column comes from the edges
 * (every edge moves at least one column right inside a segment — "one column
 * per beat"), its row from packing the forks under the main path. Sizes and
 * spacing are flow-wide (`default-node-size`, `default-node-spacing`,
 * paddings, gaps) or come from a named style in the manifest's top-level
 * `styles`.
 *
 *   { "flows": { "gorgon-duo": {
 *       "layout": "timeline",
 *       "output": "docs/…/Gorgon Duo Fight - End to End.canvas",
 *       "doc": "docs/…/Gorgon Duo Fight - End to End.md",
 *       "style": "bespoke",
 *       "timeline-groups": [{"id": "server", "label": "Server Table", "short": "server"}, …],
 *       "timeline-segments": [{"id": "spawn", "label": "Spawning and observing"}, …],
 *       "forks": {"spawnfail": {"label": "Fork · spawn refused", "color": "1"}},
 *       "clusters": {"rules-move": {"label": "rules.rs · movement claim", "color": "#8a5cf6"}},
 *       "nodes": [
 *         {"id": "s-spawn", "group": "server", "segment": "spawn", "heading": "Server spawns the Gorgon"},
 *         {"id": "rows", "group": ["p1", "p2"], "segment": "spawn", "heading": "Both clients receive the Gorgon rows"},
 *         …],
 *       "edges": ["s-spawn -> s-rows -[`nearby_enemies`]-> rows -> see", …] } } }
 *
 * Node content: `heading` (a note card: a file node on `doc` with subpath
 * `#<heading>`; an object `{lane: heading}` gives each mirrored card its
 * own), `file` (any vault file, e.g. a phase canvas), `code`
 * (`path.rs#symbol`, a narrowed code embed) or `text`.
 *
 * **Mirrored nodes.** `"group": ["p1", "p2"]` makes one card per lane (ids
 * `p1-<id>`, `p2-<id>`) — the same beat seen by both clients. An edge
 * between two nodes mirrored over the same lanes pairs the cards lane by
 * lane (`rows -> see` is `p1-rows -> p1-see` and `p2-rows -> p2-see`); an
 * edge between a single card and a mirrored node fans out/in, carrying its
 * label on the first edge only (`mirrored-edge-labels: "all"` to repeat
 * it). `id@lane` (`f2@p1`) names one card of a mirrored node.
 *
 * **Edges** are strings — `"a -> b"`, chains `"a -> b -> c"`, fan-outs
 * `"a -> b, c"`, labelled hops `"a -[label]-> b"` — or objects
 * `{from, to, label, color}` (`label` may be `{lane: label}` for mirrored
 * ends). Inside one lane an edge leaves the source's right side and enters
 * the target's left; between lanes it leaves the bottom and enters the top.
 * Edges between two main-path cards are `main-color`; any other edge takes
 * the fork card's colour (the source's, or the target's when the source is
 * on the main path). `after` on a node orders it after other nodes of its
 * segment without drawing an edge.
 *
 * **Code links** (`code-links`) derive call / table / shared-code links
 * between the cards from the generated sub-flowchart tags (see
 * flowchartCodeLinks.ts): each card's code is its `code`, its `symbols` and
 * (for note cards) every `[[file#symbol]]` link in its doc section. In
 * `report` mode (the default) nothing is drawn; the result lists the derived
 * links the chart does not draw (`missing`) and the drawn edges the code
 * backs (`confirmed`). In `draw` mode the missing ones are drawn too, styled
 * (dotted by default). Links inside one segment are always kept; a link
 * between two segments is kept only when one of its cards carries one of the
 * `across-segments` tags (default `["handoff"]`) — that is what keeps a
 * 136-card chart from exploding into every code relation it touches.
 *
 * **Sub-flowchart flows.** With `"subflowcharts-only": true` every card is a
 * canvas of the flow's own `flowcharts/Subflowcharts` tree: `code` names the
 * code (`path.rs#symbol` → its symbol canvas, `path.rs` → its codefile canvas,
 * a folder → its subfolder canvas; per lane for mirrored nodes), `canvas`
 * names a tree canvas directly, and heading/text cards are errors. With
 * `code-links.mode: "edges"` the chart's edges come from the canvases' edge
 * tags alone (`codeEdgesStep`, before layout so they rank the columns):
 * calls (`call-depth` hops through code no card shows), table hand-offs
 * (`table-depth`, through views; one nearest reader per writer and lane
 * group), and cross-side calls into shared code become `shares` links.
 * Filters: same-segment links always, cross-segment ones only via
 * `handoff`-tagged cards and within `segment-span` segments; links back in
 * time are dropped; `reduce` drops edges a longer path already implies.
 * `lane-order: "declared"` keeps each lane's main path (and each fork) in
 * declaration order and starts a fork after the main card declared before
 * it, since code-derived edges rarely spell out every beat.
 */

type Dict = Record<string, any>;

export interface TimelineStyle {
	nodeW: number;
	nodeH: number;
	gapX: number;
	gapY: number;
	groupPadding: number;
	segmentPadding: number;
	segmentGap: number;
	laneGap: number;
	grid: number;
	snapSegments: boolean;
	mainColor: string;
	frameColor: string;
	edgeStyle: Dict;
	toEnd?: string;
	mirroredLabels: "first" | "all";
	forkGap: number;
	avoidDropThrough: boolean;
	laneSuffix: boolean;
	/**
	 * `edges` (default): columns come from the edges alone. `declared`: the
	 * main-path cards of a lane (and the cards of one fork in one lane) also
	 * keep their declaration order inside a segment — for flows whose edges
	 * are derived from code and do not spell out every beat-to-beat step.
	 */
	laneOrder: "edges" | "declared";
}

export const DEFAULT_TIMELINE_STYLE: TimelineStyle = {
	nodeW: 480,
	nodeH: 480,
	gapX: 240,
	gapY: 240,
	groupPadding: 60,
	segmentPadding: 240,
	segmentGap: 720,
	laneGap: 240,
	grid: 240,
	snapSegments: false,
	mainColor: "#ffffff",
	frameColor: "#c0c0c0",
	edgeStyle: { bezierCurvature: "5" },
	toEnd: undefined,
	mirroredLabels: "first",
	forkGap: 1,
	avoidDropThrough: true,
	laneSuffix: true,
	laneOrder: "edges",
};

/** Reads one `[w, h]` / `n` pair. */
function pair(v: unknown): [number, number] | null {
	if (typeof v === "number" && Number.isFinite(v)) return [v, v];
	if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
		return [v[0], v[1]];
	}
	return null;
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Applies the flows.json style keys found on `src` onto `style` (unknown keys are ignored). */
export function applyStyleKeys(style: TimelineStyle, src: Dict | undefined): void {
	if (!src || typeof src !== "object") return;
	const size = pair(src["default-node-size"]);
	if (size) [style.nodeW, style.nodeH] = size;
	const spacing = pair(src["default-node-spacing"]);
	if (spacing) [style.gapX, style.gapY] = spacing;
	const numeric: [string, keyof TimelineStyle][] = [
		["group-padding", "groupPadding"],
		["segment-padding", "segmentPadding"],
		["segment-gap", "segmentGap"],
		["lane-gap", "laneGap"],
		["grid", "grid"],
		["fork-gap", "forkGap"],
	];
	for (const [key, field] of numeric) {
		const n = num(src[key]);
		if (n !== null) (style as any)[field] = n;
	}
	const strings: [string, keyof TimelineStyle][] = [
		["main-color", "mainColor"],
		["frame-color", "frameColor"],
		["edge-to-end", "toEnd"],
	];
	for (const [key, field] of strings) {
		if (typeof src[key] === "string") (style as any)[field] = src[key];
	}
	const bools: [string, keyof TimelineStyle][] = [
		["snap-segments", "snapSegments"],
		["avoid-drop-through", "avoidDropThrough"],
		["fork-lane-suffix", "laneSuffix"],
	];
	for (const [key, field] of bools) {
		if (typeof src[key] === "boolean") (style as any)[field] = src[key];
	}
	if (src["edge-style"] && typeof src["edge-style"] === "object") style.edgeStyle = { ...src["edge-style"] };
	if (src["lane-order"] === "edges" || src["lane-order"] === "declared") style.laneOrder = src["lane-order"];
	if (src["mirrored-edge-labels"] === "first" || src["mirrored-edge-labels"] === "all") {
		style.mirroredLabels = src["mirrored-edge-labels"];
	}
}

// ---------- spec model ----------

interface Lane {
	id: string;
	label: string;
	short: string;
	/** The code side this lane's actor runs (`server`, `client`, …) — see LinkNode.sides. */
	side?: string;
	index: number;
}

interface Segment {
	id: string;
	label: string;
	index: number;
}

interface BoxDef {
	id: string;
	label: string;
	color?: string;
	/** Per-lane label overrides. */
	labels: Record<string, string>;
	fork: boolean;
}

interface NodeDef {
	id: string;
	index: number;
	lanes: Lane[];
	segment: Segment;
	box?: BoxDef;
	main: boolean;
	color?: string;
	heading?: string | Record<string, string>;
	doc?: string;
	file?: string;
	/** `path.rs#symbol`, `path.rs` or a code folder — per lane for mirrored nodes. */
	code?: string | Record<string, string>;
	/** An explicit Subflowcharts canvas — per lane for mirrored nodes. */
	canvas?: string | Record<string, string>;
	text?: string;
	after: string[];
	tags: Set<string>;
	symbols: string[];
	cards: Card[];
	/** Resolved Subflowcharts canvas per lane id (subflowchart nodes only). */
	canvasByLane?: Map<string, string>;
}

/**
 * Resolves code references to the generated sub-flowchart canvases of the
 * flow's own `…/flowcharts/Subflowcharts` tree (built by flowchartAggregate.ts
 * from the tree's layout).
 */
export interface SubflowchartResolver {
	/**
	 * `path.rs#symbol[#n]` → its symbol canvas, `path.rs` → its codefile
	 * canvas, `path/to/folder` → its subfolder canvas, a tree `.canvas` path →
	 * itself. Null when the tree has no such canvas.
	 */
	canvasFor(ref: string): string | null;
	/** The code identities (`file#symbol`) a tree canvas covers. */
	identitiesOf(canvasPath: string): string[];
	/** Whether `path` is a canvas inside the tree. */
	isTreeCanvas(path: string): boolean;
}

interface Card {
	id: string;
	node: NodeDef;
	lane: Lane;
	index: number;
	col: number;
	minCol: number;
	row: number;
	x: number;
	y: number;
}

interface CardEdge {
	from: Card;
	to: Card;
	label?: string;
	color?: string;
	/** Set on drawn code links. */
	derived?: LinkKind;
	style?: Dict;
	toEnd?: string;
}

export interface CodeLinkReportEntry {
	from: string;
	to: string;
	kind: LinkKind;
	label: string;
	via: string[];
}

export interface CodeLinkReport {
	mode: "report" | "draw" | "edges";
	/** `edges` mode: the derived links drawn as the chart's edges. */
	drawn?: CodeLinkReportEntry[];
	/** `edges` mode: call/table links pointing back in time, not drawn. */
	backward?: CodeLinkReportEntry[];
	/** Nodes that had at least one code identity, and how many identities in all. */
	nodesWithCode: number;
	identities: number;
	/** Drawn (explicit) edges the code backs, by node pair. */
	confirmed: CodeLinkReportEntry[];
	/** Derived links the chart does not draw (in `draw` mode: drawn as derived edges). */
	missing: CodeLinkReportEntry[];
	/** Derived links dropped because they cross segments between untagged cards. */
	filtered: number;
	/** Code identities linked from the doc that no symbol canvas covers (stale link or ungenerated code). */
	unknownIdentities: string[];
}

export interface TimelineFlowResult {
	name: string;
	path: string;
	cards: number;
	groups: number;
	edges: number;
	/** Doc headings the note cards embed that the doc does not have. */
	missingHeadings: string[];
	/** `doc` / `file` / `code` paths that do not exist. */
	missingFiles: string[];
	warnings: string[];
	codeLinks?: CodeLinkReport;
}

export class TimelineSpecError extends Error {}

/** `-[label]->` (labelled hop) or `->`. */
const ARROW = /-\[([^\]]*)\]->|->/g;

/** Splits `"a -[x]-> b, c -> d"` into endpoint lists and hop labels. */
export function parseEdgeString(s: string): { ends: string[][]; labels: (string | undefined)[] } {
	const ends: string[][] = [];
	const labels: (string | undefined)[] = [];
	let last = 0;
	ARROW.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ARROW.exec(s)) !== null) {
		ends.push(splitEnds(s.slice(last, m.index)));
		labels.push(m[1] !== undefined ? m[1].trim() || undefined : undefined);
		last = m.index + m[0].length;
	}
	ends.push(splitEnds(s.slice(last)));
	return { ends, labels };
}

function splitEnds(s: string): string[] {
	return s
		.split(",")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
}

function asList(v: unknown): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	return [];
}

interface ParsedTimeline {
	name: string;
	output: string;
	style: TimelineStyle;
	lanes: Lane[];
	segments: Segment[];
	nodes: NodeDef[];
	cards: Card[];
	edges: CardEdge[];
	/** Ordering-only constraints (`after`). */
	orderEdges: [Card, Card][];
	boxes: Map<string, BoxDef>;
	codeLinks: Dict | null;
	sides: CodeSide[] | null;
	warnings: string[];
}

/**
 * Validates and expands a timeline flow spec (no layout yet). Throws
 * `TimelineSpecError` for errors that make the chart meaningless (unknown
 * lane, duplicate id, …); softer problems become warnings.
 */
function parseTimeline(name: string, spec: Dict, styles: Dict, defaultOutput: string): ParsedTimeline {
	const warnings: string[] = [];
	const fail = (msg: string): never => {
		throw new TimelineSpecError(`flow "${name}": ${msg}`);
	};

	const style: TimelineStyle = { ...DEFAULT_TIMELINE_STYLE, edgeStyle: { ...DEFAULT_TIMELINE_STYLE.edgeStyle } };
	if (typeof spec.style === "string") {
		if (!styles[spec.style]) warnings.push(`unknown style "${spec.style}" (using the built-in defaults)`);
		applyStyleKeys(style, styles[spec.style]);
	}
	applyStyleKeys(style, spec);

	const lanes: Lane[] = [];
	const laneById = new Map<string, Lane>();
	for (const raw of Array.isArray(spec["timeline-groups"]) ? spec["timeline-groups"] : []) {
		const def: Dict = typeof raw === "string" ? { id: raw } : raw ?? {};
		if (typeof def.id !== "string" || !def.id) fail(`timeline group without an id: ${JSON.stringify(raw)}`);
		if (laneById.has(def.id)) fail(`duplicate timeline group "${def.id}"`);
		const lane: Lane = {
			id: def.id,
			label: typeof def.label === "string" ? def.label : def.id,
			short: typeof def.short === "string" ? def.short : def.id,
			side: typeof def.side === "string" ? def.side : undefined,
			index: lanes.length,
		};
		lanes.push(lane);
		laneById.set(lane.id, lane);
	}
	if (lanes.length === 0) fail(`"timeline-groups" lists no groups`);

	const segments: Segment[] = [];
	const segById = new Map<string, Segment>();
	for (const raw of Array.isArray(spec["timeline-segments"]) ? spec["timeline-segments"] : []) {
		const def: Dict = typeof raw === "string" ? { id: raw } : raw ?? {};
		if (typeof def.id !== "string" || !def.id) fail(`timeline segment without an id: ${JSON.stringify(raw)}`);
		if (segById.has(def.id)) fail(`duplicate timeline segment "${def.id}"`);
		const seg: Segment = { id: def.id, label: typeof def.label === "string" ? def.label : def.id, index: segments.length };
		segments.push(seg);
		segById.set(seg.id, seg);
	}
	if (segments.length === 0) fail(`"timeline-segments" lists no segments`);

	const boxes = new Map<string, BoxDef>();
	const readBoxes = (key: string, fork: boolean) => {
		const src = spec[key];
		if (!src || typeof src !== "object") return;
		for (const [id, raw] of Object.entries(src as Dict)) {
			if (boxes.has(id)) fail(`"${id}" is defined as both a fork and a cluster`);
			const def: Dict = typeof raw === "string" ? { label: raw } : raw ?? {};
			const labels: Record<string, string> = {};
			if (def.labels && typeof def.labels === "object") {
				for (const [lane, label] of Object.entries(def.labels as Dict)) {
					if (!laneById.has(lane)) warnings.push(`${key}.${id}.labels: unknown timeline group "${lane}"`);
					if (typeof label === "string") labels[lane] = label;
				}
			}
			if (fork && typeof def.color !== "string") warnings.push(`fork "${id}" has no color`);
			boxes.set(id, {
				id,
				label: typeof def.label === "string" ? def.label : id,
				color: typeof def.color === "string" ? def.color : undefined,
				labels,
				fork,
			});
		}
	};
	readBoxes("forks", true);
	readBoxes("clusters", false);

	// ---- nodes → cards ----
	const nodes: NodeDef[] = [];
	const nodeById = new Map<string, NodeDef>();
	const cardById = new Map<string, Card>();
	const cards: Card[] = [];
	for (const raw of Array.isArray(spec.nodes) ? spec.nodes : []) {
		if (!raw || typeof raw !== "object") continue;
		const id = raw.id;
		if (typeof id !== "string" || !id) fail(`node without an id: ${JSON.stringify(raw)}`);
		if (nodeById.has(id)) fail(`duplicate node id "${id}"`);
		const laneIds = asList(raw.group);
		if (laneIds.length === 0) fail(`node "${id}" has no "group"`);
		const nodeLanes = laneIds.map((l) => laneById.get(l) ?? fail(`node "${id}": unknown timeline group "${l}"`));
		const segment =
			typeof raw.segment === "string"
				? segById.get(raw.segment) ?? fail(`node "${id}": unknown timeline segment "${raw.segment}"`)
				: fail(`node "${id}" has no "segment"`);
		const boxId = typeof raw.fork === "string" ? raw.fork : typeof raw.cluster === "string" ? raw.cluster : undefined;
		const box = boxId !== undefined ? boxes.get(boxId) ?? fail(`node "${id}": unknown fork/cluster "${boxId}"`) : undefined;
		if (typeof raw.fork === "string" && box && !box.fork) fail(`node "${id}": "${raw.fork}" is a cluster, not a fork`);
		if (typeof raw.cluster === "string" && box && box.fork) fail(`node "${id}": "${raw.cluster}" is a fork, not a cluster`);
		const contentKeys = ["heading", "file", "code", "canvas", "text"].filter((k) => raw[k] !== undefined);
		if (contentKeys.length !== 1) {
			fail(`node "${id}" needs exactly one of heading / file / code / canvas / text (has ${contentKeys.join(", ") || "none"})`);
		}
		const perLane = (v: unknown): string | Record<string, string> | undefined =>
			typeof v === "string" ? v : v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : undefined;
		const node: NodeDef = {
			id,
			index: nodes.length,
			lanes: nodeLanes,
			segment,
			box,
			main: !box?.fork,
			color: typeof raw.color === "string" ? raw.color : undefined,
			heading: typeof raw.heading === "string" || (raw.heading && typeof raw.heading === "object") ? raw.heading : undefined,
			doc: typeof raw.doc === "string" ? raw.doc : undefined,
			file: typeof raw.file === "string" ? raw.file : undefined,
			code: perLane(raw.code),
			canvas: perLane(raw.canvas),
			text: typeof raw.text === "string" ? raw.text : undefined,
			after: asList(raw.after),
			tags: new Set(asList(raw.tags)),
			symbols: asList(raw.symbols),
			cards: [],
		};
		nodes.push(node);
		nodeById.set(id, node);
		for (const lane of nodeLanes) {
			const cid = nodeLanes.length > 1 ? `${lane.id}-${id}` : id;
			if (cardById.has(cid)) fail(`card id "${cid}" (node "${id}" in "${lane.id}") collides with another card`);
			const card: Card = { id: cid, node, lane, index: cards.length, col: 0, minCol: 0, row: 0, x: 0, y: 0 };
			cards.push(card);
			cardById.set(cid, card);
			node.cards.push(card);
		}
	}
	for (const n of nodes) {
		if (cardById.has(n.id) && cardById.get(n.id)!.node !== n) fail(`node id "${n.id}" collides with a mirrored card id`);
	}
	if (cards.length === 0) fail(`no nodes`);

	/** Endpoint token → cards: a node id (all its cards), a card id, or `id@lane`. */
	const resolve = (token: string): Card[] | null => {
		const at = token.lastIndexOf("@");
		if (at > 0) {
			const node = nodeById.get(token.slice(0, at));
			const card = node?.cards.find((c) => c.lane.id === token.slice(at + 1));
			return card ? [card] : null;
		}
		const node = nodeById.get(token);
		if (node) return node.cards;
		const card = cardById.get(token);
		return card ? [card] : null;
	};

	// ---- edges ----
	const edges: CardEdge[] = [];
	const edgeKey = new Map<string, CardEdge>();
	const addHop = (fromTokens: string[], toTokens: string[], label: unknown, color: string | undefined, where: string) => {
		for (const ft of fromTokens) {
			for (const tt of toTokens) {
				const from = resolve(ft);
				const to = resolve(tt);
				if (!from) {
					warnings.push(`${where}: unknown node "${ft}"`);
					continue;
				}
				if (!to) {
					warnings.push(`${where}: unknown node "${tt}"`);
					continue;
				}
				const pairs: [Card, Card][] = [];
				if (from.length > 1 && to.length > 1) {
					for (const a of from) {
						const b = to.find((c) => c.lane === a.lane);
						if (b) pairs.push([a, b]);
					}
					if (pairs.length === 0) for (const a of from) for (const b of to) pairs.push([a, b]);
				} else {
					for (const a of from) for (const b of to) pairs.push([a, b]);
				}
				pairs.forEach(([a, b], i) => {
					if (a === b) {
						warnings.push(`${where}: self-edge on "${a.id}" dropped`);
						return;
					}
					let l: string | undefined;
					if (typeof label === "string") {
						l = style.mirroredLabels === "all" || i === 0 ? label : undefined;
					} else if (label && typeof label === "object") {
						const byLane = label as Dict;
						const v = byLane[b.lane.id] ?? byLane[a.lane.id];
						l = typeof v === "string" ? v : undefined;
					}
					const key = `${a.id}->${b.id}`;
					const prev = edgeKey.get(key);
					if (prev) {
						if (l && !prev.label) prev.label = l;
						return;
					}
					const e: CardEdge = { from: a, to: b, label: l, color };
					edgeKey.set(key, e);
					edges.push(e);
				});
			}
		}
	};
	for (const raw of Array.isArray(spec.edges) ? spec.edges : []) {
		if (typeof raw === "string") {
			const { ends, labels } = parseEdgeString(raw);
			if (ends.length < 2 || ends.some((e) => e.length === 0)) {
				warnings.push(`edge "${raw}": needs "a -> b"`);
				continue;
			}
			for (let i = 0; i + 1 < ends.length; i++) addHop(ends[i], ends[i + 1], labels[i], undefined, `edge "${raw}"`);
		} else if (raw && typeof raw === "object") {
			const from = asList(raw.from);
			const to = asList(raw.to);
			if (from.length === 0 || to.length === 0) {
				warnings.push(`edge ${JSON.stringify(raw)}: needs "from" and "to"`);
				continue;
			}
			addHop(from, to, raw.label, typeof raw.color === "string" ? raw.color : undefined, `edge ${JSON.stringify(raw)}`);
		}
	}

	const orderEdges: [Card, Card][] = [];
	for (const n of nodes) {
		for (const a of n.after) {
			const before = resolve(a);
			if (!before) {
				warnings.push(`node "${n.id}": "after" names unknown node "${a}"`);
				continue;
			}
			for (const b of before) for (const c of n.cards) orderEdges.push([b, c]);
		}
	}

	const output = typeof spec.output === "string" && spec.output ? normalizePath(spec.output) : defaultOutput;
	return {
		name,
		output,
		style,
		lanes,
		segments,
		nodes,
		cards,
		edges,
		orderEdges,
		boxes,
		codeLinks: spec["code-links"] && typeof spec["code-links"] === "object" ? spec["code-links"] : spec["code-links"] === false ? null : {},
		sides: spec.sides ? parseCodeSides(spec.sides) : null,
		warnings,
	};
}

// ---------- layout ----------

/** Column of every card of one segment: longest path over the segment's edges, main cards bumped off occupied columns. */
function assignColumns(segCards: Card[], rankEdges: [Card, Card][], warnings: string[], segLabel: string): void {
	const inSeg = new Set(segCards);
	const preds = new Map<Card, Card[]>();
	const succs = new Map<Card, Card[]>();
	for (const c of segCards) {
		preds.set(c, []);
		succs.set(c, []);
	}
	for (const [a, b] of rankEdges) {
		if (!inSeg.has(a) || !inSeg.has(b)) continue;
		preds.get(b)!.push(a);
		succs.get(a)!.push(b);
	}
	const indeg = new Map(segCards.map((c) => [c, preds.get(c)!.length]));
	const done = new Set<Card>();
	const occupied = new Map<string, Set<number>>(); // lane id → main-row columns
	let ready = segCards.filter((c) => indeg.get(c) === 0);
	let warnedCycle = false;
	while (done.size < segCards.length) {
		if (ready.length === 0) {
			// A cycle: release the earliest remaining card, ignoring its unplaced predecessors.
			const next = segCards.find((c) => !done.has(c))!;
			if (!warnedCycle) {
				warnings.push(`segment "${segLabel}": the edges form a cycle around "${next.id}"; it was placed ignoring the back edge`);
				warnedCycle = true;
			}
			ready = [next];
		}
		ready.sort((a, b) => a.index - b.index);
		const card = ready.shift()!;
		if (done.has(card)) continue;
		let col = card.minCol;
		for (const p of preds.get(card)!) if (done.has(p)) col = Math.max(col, p.col + 1);
		if (card.node.main) {
			let occ = occupied.get(card.lane.id);
			if (!occ) occupied.set(card.lane.id, (occ = new Set()));
			while (occ.has(col)) col++;
			occ.add(col);
		}
		card.col = col;
		done.add(card);
		for (const s of succs.get(card)!) {
			indeg.set(s, indeg.get(s)! - 1);
			if (indeg.get(s) === 0 && !done.has(s)) ready.push(s);
		}
	}
}

interface BoxPlacement {
	box: BoxDef;
	lane: Lane;
	segment: Segment;
	cards: Card[];
}

/** Rows of one segment's cards: main cards on row 0, each fork box packed into the first free band under it. */
function packRows(segCards: Card[], lanes: Lane[], style: TimelineStyle): void {
	for (const lane of lanes) {
		const laneCards = segCards.filter((c) => c.lane === lane);
		if (laneCards.length === 0) continue;
		const hasMain = laneCards.some((c) => c.node.main);
		const occupied = new Map<number, Set<number>>();
		const occ = (row: number) => {
			let s = occupied.get(row);
			if (!s) occupied.set(row, (s = new Set()));
			return s;
		};
		for (const c of laneCards) {
			if (!c.node.main) continue;
			c.row = 0;
			occ(0).add(c.col);
		}
		// Fork boxes of this lane, in order of their first card.
		const groups = new Map<string, Card[]>();
		for (const c of laneCards) {
			if (c.node.main) continue;
			const key = c.node.box!.id;
			const g = groups.get(key) ?? [];
			g.push(c);
			groups.set(key, g);
		}
		const placed = [...groups.values()].map((g) => {
			// Stack cards of one box that share a column.
			const inner = new Map<Card, number>();
			const used: Set<number>[] = [];
			for (const c of [...g].sort((a, b) => a.col - b.col || a.index - b.index)) {
				let r = 0;
				while (used[r]?.has(c.col)) r++;
				if (!used[r]) used[r] = new Set();
				used[r].add(c.col);
				inner.set(c, r);
			}
			const minCol = Math.min(...g.map((c) => c.col));
			const maxCol = Math.max(...g.map((c) => c.col));
			return { cards: g, inner, minCol, maxCol, height: used.length, first: Math.min(...g.map((c) => c.index)) };
		});
		placed.sort((a, b) => a.minCol - b.minCol || a.first - b.first);
		for (const g of placed) {
			let row = hasMain ? 1 : 0;
			const fits = (r: number) => {
				for (let i = 0; i < g.height; i++) {
					const s = occupied.get(r + i);
					if (!s) continue;
					for (let col = g.minCol - style.forkGap; col <= g.maxCol + style.forkGap; col++) if (s.has(col)) return false;
				}
				return true;
			};
			while (!fits(row)) row++;
			for (let i = 0; i < g.height; i++) for (let col = g.minCol; col <= g.maxCol; col++) occ(row + i).add(col);
			for (const c of g.cards) c.row = row + g.inner.get(c)!;
		}
	}
}

/** Fork cards that sit straight under a same-lane card whose cross-lane edge drops out of its bottom. */
function dropThroughConflicts(segCards: Card[], edges: CardEdge[]): Card[] {
	const dropping = new Set<Card>();
	for (const e of edges) if (e.from.lane !== e.to.lane) dropping.add(e.from);
	const out: Card[] = [];
	for (const f of segCards) {
		if (f.node.main) continue;
		const hit = segCards.some((c) => c !== f && c.lane === f.lane && c.col === f.col && c.row < f.row && dropping.has(c));
		if (hit) out.push(f);
	}
	return out;
}

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

function bbox(rects: Rect[]): Rect | null {
	if (rects.length === 0) return null;
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function grow(r: Rect, by: number): Rect {
	return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

function snapUp(v: number, grid: number): number {
	return grid > 0 ? Math.ceil(v / grid) * grid : v;
}

interface Layout {
	segmentBoxes: Map<Segment, Rect>;
	laneBoxes: Map<Lane, Rect>;
	boxPlacements: { placement: BoxPlacement; rect: Rect; id: string; label: string }[];
}

function layoutTimeline(t: ParsedTimeline): Layout {
	const { style, lanes, segments, cards, edges, warnings } = t;
	const rankEdges: [Card, Card][] = [...edges.map((e): [Card, Card] => [e.from, e.to]), ...t.orderEdges];
	if (style.laneOrder === "declared") {
		// Main cards of a lane, and the cards of one fork in one lane, keep their declared order;
		// a fork's first card in a lane sits after the main card declared before it there
		// (the beat it branches from).
		const last = new Map<string, Card>();
		const lastMain = new Map<string, Card>();
		for (const c of cards) {
			const laneSeg = `${c.lane.id}|${c.node.segment.id}`;
			const key = `${laneSeg}|${c.node.main ? "main" : c.node.box!.id}`;
			const prev = last.get(key);
			if (prev) rankEdges.push([prev, c]);
			else if (!c.node.main && lastMain.has(laneSeg)) rankEdges.push([lastMain.get(laneSeg)!, c]);
			last.set(key, c);
			if (c.node.main) lastMain.set(laneSeg, c);
		}
	}
	for (const e of edges) {
		if (e.from.node.segment.index > e.to.node.segment.index) {
			warnings.push(`edge ${e.from.id} -> ${e.to.id} goes back in time (segment "${e.from.node.segment.label}" -> "${e.to.node.segment.label}")`);
		}
	}

	// ---- columns + rows, per segment ----
	for (const seg of segments) {
		const segCards = cards.filter((c) => c.node.segment === seg);
		if (segCards.length === 0) {
			warnings.push(`segment "${seg.label}" has no nodes`);
			continue;
		}
		for (let iter = 0; ; iter++) {
			assignColumns(segCards, rankEdges, warnings, seg.label);
			packRows(segCards, lanes, style);
			if (!style.avoidDropThrough) break;
			const conflicts = dropThroughConflicts(segCards, edges);
			if (conflicts.length === 0) break;
			if (iter >= 40) {
				warnings.push(`segment "${seg.label}": could not move ${conflicts.map((c) => c.id).join(", ")} out from under a cross-lane edge`);
				break;
			}
			for (const c of conflicts) c.minCol = c.col + 1;
		}
		// Drop columns nothing ended up in.
		const used = [...new Set(segCards.map((c) => c.col))].sort((a, b) => a - b);
		const dense = new Map(used.map((c, i) => [c, i]));
		for (const c of segCards) c.col = dense.get(c.col)!;
	}

	// ---- box placements (fork / cluster groups: one per box, lane and segment) ----
	const placements = new Map<string, BoxPlacement>();
	for (const c of cards) {
		const box = c.node.box;
		if (!box) continue;
		const key = `${box.id}|${c.lane.id}|${c.node.segment.id}`;
		let p = placements.get(key);
		if (!p) placements.set(key, (p = { box, lane: c.lane, segment: c.node.segment, cards: [] }));
		p.cards.push(c);
	}
	const inBox = new Set<Card>();
	for (const p of placements.values()) for (const c of p.cards) inBox.add(c);

	const pitchX = style.nodeW + style.gapX;
	const pitchY = style.nodeH + style.gapY;
	const pad = style.groupPadding;

	// ---- x: segments left to right, exactly segmentGap apart ----
	const segmentBoxes = new Map<Segment, Rect>();
	let prevRight: number | null = null;
	const boxRect = (p: BoxPlacement): Rect =>
		grow(bbox(p.cards.map((c) => ({ x: c.x, y: c.y, w: style.nodeW, h: style.nodeH })))!, pad);
	const placeX = (seg: Segment) => {
		const segCards = cards.filter((c) => c.node.segment === seg);
		if (segCards.length === 0) return;
		const leftInset = segCards.some((c) => c.col === 0 && inBox.has(c)) ? pad : 0;
		let origin = prevRight === null ? 0 : prevRight + style.segmentGap + style.segmentPadding + leftInset;
		if (style.snapSegments) origin = snapUp(origin, style.grid);
		for (const c of segCards) c.x = origin + c.col * pitchX;
	};

	// ---- y: lanes top to bottom ----
	const laneRows = new Map<Lane, number>();
	for (const c of cards) laneRows.set(c.lane, Math.max(laneRows.get(c.lane) ?? 0, c.row + 1));
	const laneTop = new Map<Lane, number>();
	let prevBottom: number | null = null as number | null;
	for (const lane of lanes) {
		const laneCards = cards.filter((c) => c.lane === lane);
		const row0Boxed = laneCards.some((c) => c.row === 0 && inBox.has(c));
		const topInset = pad + (row0Boxed ? pad : 0);
		const top: number = prevBottom === null ? 0 : snapUp(prevBottom + style.laneGap + topInset, style.grid);
		laneTop.set(lane, top);
		for (const c of laneCards) c.y = top + c.row * pitchY;
		const rows = laneRows.get(lane) ?? 1;
		const bottomRowBoxed = laneCards.some((c) => c.row === rows - 1 && inBox.has(c));
		prevBottom = top + (rows - 1) * pitchY + style.nodeH + pad + (bottomRowBoxed ? pad : 0);
	}

	for (const seg of segments) {
		placeX(seg);
		const segCards = cards.filter((c) => c.node.segment === seg);
		if (segCards.length === 0) continue;
		const rects: Rect[] = segCards.map((c) => ({ x: c.x, y: c.y, w: style.nodeW, h: style.nodeH }));
		for (const p of placements.values()) if (p.segment === seg) rects.push(boxRect(p));
		const b = bbox(rects)!;
		segmentBoxes.set(seg, { x: b.x - style.segmentPadding, y: 0, w: b.w + 2 * style.segmentPadding, h: 0 });
		prevRight = b.x + b.w + style.segmentPadding;
	}

	// ---- lane boxes: every lane spans the same left/right edge ----
	const boxPlacements = [...placements.values()].map((placement) => {
		const forkLanes = new Set(cards.filter((c) => c.node.box === placement.box).map((c) => c.lane.id));
		const forkSegs = new Set(cards.filter((c) => c.node.box === placement.box).map((c) => c.node.segment.id));
		let id = `G-${placement.box.id}`;
		if (forkLanes.size > 1) id += `-${placement.lane.id}`;
		if (forkSegs.size > 1) id += `-${placement.segment.id}`;
		const label =
			placement.box.labels[placement.lane.id] ??
			(forkLanes.size > 1 && style.laneSuffix ? `${placement.box.label} (${placement.lane.short})` : placement.box.label);
		return { placement, rect: boxRect(placement), id, label };
	});
	const allRects: Rect[] = [
		...cards.map((c) => ({ x: c.x, y: c.y, w: style.nodeW, h: style.nodeH })),
		...boxPlacements.map((b) => b.rect),
	];
	const all = bbox(allRects)!;
	const laneBoxes = new Map<Lane, Rect>();
	for (const lane of lanes) {
		const rects: Rect[] = [
			...cards.filter((c) => c.lane === lane).map((c) => ({ x: c.x, y: c.y, w: style.nodeW, h: style.nodeH })),
			...boxPlacements.filter((b) => b.placement.lane === lane).map((b) => b.rect),
		];
		const b = bbox(rects) ?? { x: all.x, y: laneTop.get(lane)!, w: all.w, h: style.nodeH };
		laneBoxes.set(lane, { x: all.x - pad, y: b.y - pad, w: all.w + 2 * pad, h: b.h + 2 * pad });
	}
	const firstLane = laneBoxes.get(lanes[0])!;
	const lastLane = laneBoxes.get(lanes[lanes.length - 1])!;
	for (const r of segmentBoxes.values()) {
		r.y = firstLane.y - style.segmentPadding;
		r.h = lastLane.y + lastLane.h + style.segmentPadding - r.y;
	}
	return { segmentBoxes, laneBoxes, boxPlacements };
}

// ---------- canvas JSON ----------

/** A per-lane value (`{lane: value}`) for one lane, or the plain value. */
function laneValue(v: string | Record<string, string>, lane: string): string {
	return typeof v === "string" ? v : v[lane] ?? Object.values(v)[0] ?? "";
}

/** Every value of a plain or per-lane value. */
function laneValues(v: string | Record<string, string> | undefined): string[] {
	if (v === undefined) return [];
	return typeof v === "string" ? [v] : Object.values(v);
}

function cardColor(c: Card, style: TimelineStyle): string | undefined {
	return c.node.color ?? (c.node.main ? style.mainColor : c.node.box?.color);
}

function edgeColor(e: CardEdge, style: TimelineStyle): string | undefined {
	if (e.color) return e.color;
	if (!e.from.node.main) return cardColor(e.from, style);
	if (!e.to.node.main) return cardColor(e.to, style);
	return style.mainColor;
}

function buildTimelineCanvas(t: ParsedTimeline, layout: Layout, defaultDoc: string | undefined): { nodes: Dict[]; edges: Dict[] } {
	const { style } = t;
	const nodes: Dict[] = [];
	const group = (id: string, r: Rect, label: string, color?: string) => {
		const g: Dict = { id, type: "group", x: r.x, y: r.y, width: r.w, height: r.h };
		if (color) g.color = color;
		g.label = label;
		nodes.push(g);
	};
	for (const seg of t.segments) {
		const r = layout.segmentBoxes.get(seg);
		if (r) group(`S-${seg.id}`, r, seg.label, style.frameColor);
	}
	for (const lane of t.lanes) group(`L-${lane.id}`, layout.laneBoxes.get(lane)!, lane.label, style.frameColor);
	for (const b of layout.boxPlacements) group(b.id, b.rect, b.label, b.placement.box.color);

	for (const c of t.cards) {
		const n: Dict = { id: c.id };
		const node = c.node;
		if (node.heading !== undefined) {
			const heading =
				typeof node.heading === "string" ? node.heading : (node.heading as Record<string, string>)[c.lane.id] ?? Object.values(node.heading)[0];
			n.type = "file";
			n.file = node.doc ?? defaultDoc;
			n.subpath = `#${heading}`;
		} else if (node.canvasByLane?.has(c.lane.id)) {
			n.type = "file";
			n.file = node.canvasByLane.get(c.lane.id);
		} else if (node.file !== undefined) {
			n.type = "file";
			n.file = node.file;
		} else if (node.code !== undefined) {
			const code = laneValue(node.code, c.lane.id);
			const hash = code.indexOf("#");
			n.type = "file";
			n.file = hash < 0 ? code : code.slice(0, hash);
			if (hash >= 0) n.subpath = code.slice(hash);
		} else {
			n.type = "text";
			n.text = node.text ?? "";
		}
		n.x = c.x;
		n.y = c.y;
		n.width = style.nodeW;
		n.height = style.nodeH;
		const color = cardColor(c, style);
		if (color) n.color = color;
		nodes.push(n);
	}

	const edges: Dict[] = [];
	const ids = new Set<string>();
	for (const e of t.edges) {
		let id = `e-${e.from.id}-${e.to.id}`;
		for (let i = 2; ids.has(id); i++) id = `e-${e.from.id}-${e.to.id}-${i}`;
		ids.add(id);
		const sameLane = e.from.lane === e.to.lane;
		const out: Dict = { id };
		const styleAttributes = { ...style.edgeStyle, ...(e.style ?? {}) };
		if (Object.keys(styleAttributes).length > 0) out.styleAttributes = styleAttributes;
		out.fromNode = e.from.id;
		out.fromSide = sameLane ? "right" : "bottom";
		out.toNode = e.to.id;
		out.toSide = sameLane ? "left" : "top";
		const color = edgeColor(e, style);
		if (color) out.color = color;
		if (e.label) out.label = e.label;
		const toEnd = e.toEnd ?? style.toEnd;
		if (toEnd) out.toEnd = toEnd;
		edges.push(out);
	}
	return { nodes, edges };
}

// ---------- code links ----------

/** Every node's code identities: its subflowchart canvases' coverage, `code`, `symbols` and (optionally) its doc section's links. */
function nodeIdentities(
	app: App,
	t: ParsedTimeline,
	fromDoc: boolean,
	defaultDoc: string | undefined,
	resolver: SubflowchartResolver | null,
): Map<NodeDef, Set<string>> {
	const out = new Map<NodeDef, Set<string>>();
	for (const n of t.nodes) {
		const ids = new Set<string>();
		if (n.canvasByLane && resolver) {
			for (const canvas of new Set(n.canvasByLane.values())) for (const id of resolver.identitiesOf(canvas)) ids.add(id);
		} else {
			for (const code of laneValues(n.code)) if (code.includes("#")) ids.add(code);
		}
		for (const s of n.symbols) ids.add(s);
		if (fromDoc && n.heading !== undefined) {
			const doc = app.vault.getAbstractFileByPath(n.doc ?? defaultDoc ?? "");
			if (doc instanceof TFile) {
				const headings = typeof n.heading === "string" ? [n.heading] : Object.values(n.heading);
				for (const h of headings) for (const id of docSectionCodeIdentities(app, doc, h)) ids.add(id);
			}
		}
		out.set(n, ids);
	}
	return out;
}

/** The deriveLinks options a `code-links` block asks for. */
function deriveOptions(cfg: Dict, t: ParsedTimeline, defaultSides: CodeSide[], edgesMode: boolean) {
	const kinds = asList(cfg.kinds).filter((k) => k === "call" || k === "table" || k === "shared") as LinkKind[];
	const order = new Map<string, number>();
	const laneKey = new Map<string, string>();
	for (const n of t.nodes) {
		order.set(n.id, n.segment.index * 1e6 + n.index);
		laneKey.set(n.id, n.lanes.map((l) => l.id).join("+"));
	}
	return {
		kinds: kinds.length > 0 ? kinds : (["call", "table", "shared"] as LinkKind[]),
		sides: t.sides ?? defaultSides,
		sharedDepth: typeof cfg["shared-depth"] === "number" ? cfg["shared-depth"] : 2,
		sharedMaxUsers: typeof cfg["shared-max-users"] === "number" ? cfg["shared-max-users"] : 4,
		sharedIgnore: asList(cfg["shared-ignore"]),
		maxUsers: typeof cfg["max-users"] === "number" ? cfg["max-users"] : edgesMode ? Number.MAX_SAFE_INTEGER : 3,
		callTargets: (cfg["call-targets"] === "all" || (edgesMode && cfg["call-targets"] !== "functions") ? "all" : "functions") as
			| "all"
			| "functions",
		resolve: (cfg.resolve === "all" ? "all" : cfg.resolve === "nearest" || edgesMode ? "nearest" : "all") as "all" | "nearest",
		order,
		laneKey,
		tableDepth: typeof cfg["table-depth"] === "number" ? cfg["table-depth"] : edgesMode ? 2 : 0,
		callLabels: (cfg["call-labels"] === "full" ? "full" : edgesMode ? "network" : "full") as "full" | "network",
		callDepth: typeof cfg["call-depth"] === "number" ? cfg["call-depth"] : 1,
		sharedTargets: (cfg["shared-targets"] === "all" ? "all" : cfg["shared-targets"] === "functions" || edgesMode ? "functions" : "all") as
			| "all"
			| "functions",
		tableResolve: (cfg["table-resolve"] === "table" ? "table" : cfg["table-resolve"] === "writer" || edgesMode ? "writer" : "table") as
			| "table"
			| "writer",
	};
}

/** Whether a derived link between `a` and `b` survives the segment filter. */
function acrossSegmentsAllowed(cfg: Dict, a: NodeDef, b: NodeDef): boolean {
	if (a.segment === b.segment) return true;
	// `segment-span`: how many segments apart two linked nodes may be (1 = neighbouring segments only).
	if (typeof cfg["segment-span"] === "number" && Math.abs(a.segment.index - b.segment.index) > cfg["segment-span"]) return false;
	if (cfg["across-segments"] === "all") return true;
	if (cfg["across-segments"] === "none") return false;
	const tags = asList(cfg["across-segments"] ?? ["handoff"]);
	return tags.some((tag) => a.tags.has(tag) || b.tags.has(tag));
}

/**
 * Card pairs for a derived node-level link: lane by lane whenever the two
 * nodes share a lane (two mirrored nodes, or a mirrored node and a card in
 * one of its lanes — P2's copy of a client step must not point at P1's
 * card), fanned out otherwise (a server card feeding both clients).
 */
function cardPairs(a: NodeDef, b: NodeDef): [Card, Card][] {
	const same: [Card, Card][] = [];
	for (const ca of a.cards) {
		const cb = b.cards.find((c) => c.lane === ca.lane);
		if (cb) same.push([ca, cb]);
	}
	if (same.length > 0) return same;
	const pairs: [Card, Card][] = [];
	for (const ca of a.cards) for (const cb of b.cards) pairs.push([ca, cb]);
	return pairs;
}

/**
 * `code-links.mode: "edges"` — the derived links ARE the chart's edges
 * (before layout, so they rank the columns). Kept: every link inside one
 * segment, links across segments touching an `across-segments` tag. A
 * call/table link pointing back in time (to an earlier node) is dropped and
 * reported unless `backward: "draw"`; shared links are drawn left to right,
 * dotted and arrowless; a plain call from one side's card into shared code
 * another side's card shows becomes a shared link too (both run that code).
 * One edge per node pair: reducer call > plain call > table hand-off > shared.
 * At most `shared-per-node` (default 1) shared links per node. With
 * `reduce: true` a plain call that a longer path of calls implies, or a table
 * hand-off that any longer path implies, is dropped.
 */
function codeEdgesStep(
	app: App,
	t: ParsedTimeline,
	index: CodeIndex,
	defaultSides: CodeSide[],
	defaultDoc: string | undefined,
	resolver: SubflowchartResolver | null,
): CodeLinkReport {
	const cfg = t.codeLinks ?? {};
	const idsByNode = nodeIdentities(app, t, cfg["from-doc-links"] !== false, defaultDoc, resolver);
	const linkNodes: LinkNode[] = [];
	const unknown = new Set<string>();
	let identities = 0;
	for (const n of t.nodes) {
		const ids = idsByNode.get(n)!;
		for (const id of ids) if (!index.targets.has(id)) unknown.add(id);
		if (ids.size === 0) continue;
		identities += ids.size;
		linkNodes.push({ id: n.id, identities: [...ids], sides: [...new Set(n.lanes.map((l) => l.side).filter((x): x is string => !!x))] });
	}
	const opts = deriveOptions(cfg, t, defaultSides, true);
	const derived = deriveLinks(index, linkNodes, opts);
	const nodeById = new Map(t.nodes.map((n) => [n.id, n]));
	const report: CodeLinkReport = {
		mode: "edges",
		nodesWithCode: linkNodes.length,
		identities,
		confirmed: [],
		missing: [],
		filtered: 0,
		unknownIdentities: [...unknown].sort(),
		drawn: [],
		backward: [],
	};
	// One edge per node pair: a reducer call beats a plain call beats a table hand-off beats shared code.
	const rankOf = (l: DerivedLink) => (l.kind === "call" ? (l.label ? 0 : 1) : l.kind === "table" ? 2 : 3);
	const best = new Map<string, DerivedLink>();
	const laneSides = (n: NodeDef) => new Set(n.lanes.map((x) => x.side).filter((x): x is string => !!x));
	for (const raw of derived) {
		const a = nodeById.get(raw.from)!;
		const b = nodeById.get(raw.to)!;
		let l = raw;
		// A plain call from one side's card into shared code another side's card
		// shows is not a call between the actors: both run that code. Show it as shared.
		const target = l.via[l.via.length - 1];
		if (l.kind === "call" && !l.label && target) {
			const sa = laneSides(a);
			const sb = laneSides(b);
			const crossSide = sa.size > 0 && sb.size > 0 && ![...sa].some((x) => sb.has(x));
			const shared = (t.sides ?? defaultSides).length > 0 && sideOf(target.split("#")[0], t.sides ?? defaultSides) === null;
			if (crossSide && shared) l = { ...l, kind: "shared", label: `shares \`${target.split("#")[1] ?? target}\`` };
		}
		if (!acrossSegmentsAllowed(cfg, a, b)) {
			report.filtered++;
			continue;
		}
		let from = l.from;
		let to = l.to;
		if (opts.order.get(from)! > opts.order.get(to)!) {
			if (l.kind !== "shared") {
				if (cfg.backward !== "draw") {
					report.backward!.push({ from: l.from, to: l.to, kind: l.kind, label: l.label, via: l.via });
					continue;
				}
			} else {
				[from, to] = [to, from];
			}
		}
		const key = `${from}->${to}`;
		const rev = `${to}->${from}`;
		const prev = best.get(key) ?? best.get(rev);
		const cand = { ...l, from, to };
		if (!prev || rankOf(cand) < rankOf(prev)) {
			best.delete(rev);
			best.set(key, cand);
		}
	}
	let kept = [...best.values()];
	// At most `shared-per-node` shared links per node (the nearest ones in time).
	const sharedCap = typeof cfg["shared-per-node"] === "number" ? cfg["shared-per-node"] : 1;
	const sharedCount = new Map<string, number>();
	const dist = (l: DerivedLink) => Math.abs(opts.order.get(l.to)! - opts.order.get(l.from)!);
	const shared = kept.filter((l) => l.kind === "shared").sort((x, y) => dist(x) - dist(y));
	const keepShared = new Set<DerivedLink>();
	for (const l of shared) {
		if ((sharedCount.get(l.from) ?? 0) >= sharedCap || (sharedCount.get(l.to) ?? 0) >= sharedCap) continue;
		sharedCount.set(l.from, (sharedCount.get(l.from) ?? 0) + 1);
		sharedCount.set(l.to, (sharedCount.get(l.to) ?? 0) + 1);
		keepShared.add(l);
	}
	kept = kept.filter((l) => l.kind !== "shared" || keepShared.has(l));
	if (cfg.reduce === true) {
		// Transitive reduction of unlabelled calls: drop a -> c when a -> … -> c exists.
		const succ = new Map<string, Set<string>>();
		for (const l of kept) {
			if (l.kind === "shared") continue;
			const s = succ.get(l.from) ?? new Set<string>();
			s.add(l.to);
			succ.set(l.from, s);
		}
		const callSucc = new Map<string, Set<string>>();
		for (const l of kept) {
			if (l.kind !== "call") continue;
			const s = callSucc.get(l.from) ?? new Set<string>();
			s.add(l.to);
			callSucc.set(l.from, s);
		}
		const reachable = (graph: Map<string, Set<string>>, from: string, to: string): boolean => {
			const seen = new Set<string>();
			const stack = [...(graph.get(from) ?? [])].filter((x) => x !== to);
			while (stack.length > 0) {
				const x = stack.pop()!;
				if (x === to) return true;
				if (seen.has(x)) continue;
				seen.add(x);
				for (const y of graph.get(x) ?? []) stack.push(y);
			}
			return false;
		};
		// Reducer calls (labelled) and shared links always stay; a plain call goes when a longer
		// path of calls implies it, a table hand-off when any longer path does.
		kept = kept.filter((l) => {
			if (l.kind === "shared" || (l.kind === "call" && !!l.label)) return true;
			return !reachable(l.kind === "call" ? callSucc : succ, l.from, l.to);
		});
	}
	const sharedStyle: Dict = cfg["shared-style"] && typeof cfg["shared-style"] === "object" ? cfg["shared-style"] : { path: "dotted" };
	// Peer lanes — lanes some mirrored node spans (P1 and P2) — are two copies of one
	// program: one never calls into or reads for the other, so only shared-code links
	// may join them. (The relay and the server share a side but are different programs.)
	const peers = new Set<string>();
	for (const n of t.nodes) {
		for (const x of n.lanes) for (const y of n.lanes) if (x !== y) peers.add(`${x.id}|${y.id}`);
	}
	for (const l of kept) {
		const a = nodeById.get(l.from)!;
		const b = nodeById.get(l.to)!;
		const pairs = cardPairs(a, b).filter(([ca, cb]) => l.kind === "shared" || !peers.has(`${ca.lane.id}|${cb.lane.id}`));
		if (pairs.length === 0) continue;
		pairs.forEach(([ca, cb], i) => {
			if (t.edges.some((e) => e.from === ca && e.to === cb)) return;
			t.edges.push({
				from: ca,
				to: cb,
				label: i === 0 || t.style.mirroredLabels === "all" ? l.label || undefined : undefined,
				derived: l.kind,
				style: l.kind === "shared" ? sharedStyle : undefined,
				toEnd: l.kind === "shared" ? "none" : undefined,
			});
		});
		report.drawn!.push({ from: l.from, to: l.to, kind: l.kind, label: l.label, via: l.via });
	}
	return report;
}

function codeLinkStep(
	app: App,
	t: ParsedTimeline,
	index: CodeIndex,
	defaultSides: CodeSide[],
	defaultDoc: string | undefined,
	resolver: SubflowchartResolver | null = null,
): CodeLinkReport | undefined {
	const cfg = t.codeLinks;
	if (!cfg) return undefined;
	const mode = cfg.mode === "draw" ? "draw" : cfg.mode === "off" || cfg.mode === "edges" ? null : "report";
	if (!mode) return undefined;
	const acrossTags = new Set(cfg["across-segments"] === "all" ? [] : asList(cfg["across-segments"] ?? ["handoff"]));
	const acrossAll = cfg["across-segments"] === "all";
	const acrossNone = cfg["across-segments"] === "none";

	// Node → code identities.
	const idsByNode = nodeIdentities(app, t, cfg["from-doc-links"] !== false, defaultDoc, resolver);
	const linkNodes: LinkNode[] = [];
	let identities = 0;
	const unknown = new Set<string>();
	for (const n of t.nodes) {
		const ids = idsByNode.get(n)!;
		for (const id of ids) if (!index.targets.has(id)) unknown.add(id);
		if (ids.size > 0) {
			const sides = [...new Set(n.lanes.map((l) => l.side).filter((x): x is string => !!x))];
			linkNodes.push({ id: n.id, identities: [...ids], sides });
			identities += ids.size;
		}
	}
	const derived = deriveLinks(index, linkNodes, deriveOptions(cfg, t, defaultSides, false));

	const nodeById = new Map(t.nodes.map((n) => [n.id, n]));
	const drawnPairs = new Set<string>();
	for (const e of t.edges) {
		drawnPairs.add(`${e.from.node.id}->${e.to.node.id}`);
		drawnPairs.add(`${e.to.node.id}->${e.from.node.id}`);
	}
	const report: CodeLinkReport = {
		mode,
		nodesWithCode: linkNodes.length,
		identities,
		confirmed: [],
		missing: [],
		filtered: 0,
		unknownIdentities: [...unknown].sort(),
	};
	const confirmedPairs = new Set<string>();
	const missingPairs = new Set<string>();
	for (const l of derived) {
		const a = nodeById.get(l.from)!;
		const b = nodeById.get(l.to)!;
		const entry: CodeLinkReportEntry = { from: l.from, to: l.to, kind: l.kind, label: l.label, via: l.via };
		const pair = `${l.from}->${l.to}`;
		if (drawnPairs.has(pair)) {
			if (!confirmedPairs.has(pair)) report.confirmed.push(entry);
			confirmedPairs.add(pair);
			continue;
		}
		const sameSegment = a.segment === b.segment;
		const tagged = [...acrossTags].some((tag) => a.tags.has(tag) || b.tags.has(tag));
		if (!sameSegment && (acrossNone || (!acrossAll && !tagged))) {
			report.filtered++;
			continue;
		}
		if (missingPairs.has(pair)) continue; // one entry per pair (first kind wins)
		missingPairs.add(pair);
		report.missing.push(entry);
	}

	if (mode === "draw") {
		const drawStyle: Dict = cfg.style && typeof cfg.style === "object" ? cfg.style : { path: "dotted" };
		for (const l of report.missing) {
			const a = nodeById.get(l.from)!;
			const b = nodeById.get(l.to)!;
			// Draw left to right (shared links are undirected; call/table ones going
			// back in time are left in the report).
			let from = a;
			let to = b;
			const order = (n: NodeDef) => n.segment.index * 1e6 + Math.min(...n.cards.map((c) => c.col));
			if (order(from) > order(to)) {
				if (l.kind !== "shared") continue;
				[from, to] = [to, from];
			}
			const pairs: [Card, Card][] = [];
			for (const ca of from.cards) {
				const cb = to.cards.find((c) => c.lane === ca.lane) ?? (to.cards.length === 1 ? to.cards[0] : undefined);
				if (cb) pairs.push([ca, cb]);
			}
			if (pairs.length === 0) pairs.push([from.cards[0], to.cards[0]]);
			pairs.forEach(([ca, cb], i) => {
				t.edges.push({
					from: ca,
					to: cb,
					label: i === 0 ? l.label : undefined,
					derived: l.kind,
					style: drawStyle,
					color: typeof cfg.color === "string" ? cfg.color : undefined,
					toEnd: l.kind === "shared" ? "none" : undefined,
				});
			});
		}
	}
	return report;
}

// ---------- entry point ----------

/**
 * Resolves `canvas` nodes (and, with `subflowchartsOnly`, `code` nodes) to
 * Subflowcharts canvases per lane. With `subflowchartsOnly` every node must
 * end up as a tree canvas: `heading`/`text` nodes and `file`s outside the
 * tree are errors. Unresolvable references are collected into one
 * `TimelineSpecError`.
 */
function resolveSubflowcharts(t: ParsedTimeline, subflowchartsOnly: boolean, resolver: SubflowchartResolver | null): void {
	const errors: string[] = [];
	for (const n of t.nodes) {
		const ref = n.canvas ?? (subflowchartsOnly ? n.code : undefined);
		if (ref === undefined) {
			if (!subflowchartsOnly) continue;
			if (n.file !== undefined && resolver?.isTreeCanvas(n.file)) continue;
			errors.push(`"${n.id}" is not a Subflowcharts canvas (use "code" or "canvas")`);
			continue;
		}
		if (!resolver) {
			errors.push(`"${n.id}": no Subflowcharts tree next to flows.json to resolve "${laneValues(ref).join(", ")}"`);
			continue;
		}
		const byLane = new Map<string, string>();
		for (const lane of n.lanes) {
			const r = laneValue(ref, lane.id);
			const canvas = resolver.canvasFor(r);
			if (canvas) byLane.set(lane.id, canvas);
			else errors.push(`"${n.id}": no Subflowcharts canvas for "${r}"`);
		}
		n.canvasByLane = byLane;
	}
	if (errors.length > 0) {
		throw new TimelineSpecError(`flow "${t.name}": ${errors.length} node(s) without a canvas: ${errors.join("; ")}`);
	}
}

/** Whether a flows.json entry is a timeline flow. */
export function isTimelineFlow(entry: unknown): entry is Dict {
	return !!entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Dict).layout === "timeline";
}

/**
 * Lays out and writes one timeline flow. `index` (the tree's code index) is
 * only needed for `code-links`; pass null to skip them. Throws
 * `TimelineSpecError` for a spec that cannot be laid out.
 */
export async function composeTimelineFlow(
	app: App,
	name: string,
	spec: Dict,
	opts: {
		styles: Dict;
		defaultOutput: string;
		manifestPath: string;
		index: CodeIndex | null;
		sides: CodeSide[];
		/** The flow's Subflowcharts tree (needed for `canvas` nodes, `subflowcharts-only` and their code links). */
		resolver?: SubflowchartResolver | null;
	},
): Promise<TimelineFlowResult> {
	const t = parseTimeline(name, spec, opts.styles ?? {}, opts.defaultOutput);
	const defaultDoc = typeof spec.doc === "string" ? normalizePath(spec.doc) : undefined;
	const resolver = opts.resolver ?? null;
	resolveSubflowcharts(t, spec["subflowcharts-only"] === true, resolver);
	const edgesMode = !!t.codeLinks && t.codeLinks.mode === "edges";
	if (edgesMode && !opts.index) {
		throw new TimelineSpecError(`flow "${name}": code-links mode "edges" needs the Subflowcharts tree next to flows.json`);
	}
	const edgeReport = edgesMode ? codeEdgesStep(app, t, opts.index!, opts.sides, defaultDoc, resolver) : undefined;
	const layout = layoutTimeline(t);
	const codeLinks = edgeReport ?? (opts.index ? codeLinkStep(app, t, opts.index, opts.sides, defaultDoc, resolver) : undefined);
	const data = buildTimelineCanvas(t, layout, defaultDoc);

	// ---- checks: files and doc headings ----
	const missingFiles = new Set<string>();
	const missingHeadings = new Set<string>();
	for (const n of data.nodes) {
		if (n.type !== "file") continue;
		const f = app.vault.getAbstractFileByPath(n.file);
		if (!(f instanceof TFile)) {
			missingFiles.add(n.file ?? "(no doc)");
			continue;
		}
		if (f.extension === "md" && typeof n.subpath === "string") {
			const heading = n.subpath.slice(1);
			const headings = app.metadataCache.getFileCache(f)?.headings ?? [];
			if (!headings.some((h) => h.heading === heading)) missingHeadings.add(heading);
		}
	}

	await writeCanvas(app, t.output, data, {
		keepGeometry: false,
		metadata: { version: "1.0-1.0", frontmatter: {} },
	});
	return {
		name,
		path: t.output,
		cards: t.cards.length,
		groups: data.nodes.length - t.cards.length,
		edges: data.edges.length,
		missingHeadings: [...missingHeadings].sort(),
		missingFiles: [...missingFiles].sort(),
		warnings: t.warnings,
		codeLinks,
	};
}

