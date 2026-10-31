import {
	App,
	ButtonComponent,
	FuzzySuggestModal,
	Menu,
	MenuItem,
	Modal,
	Notice,
	TFile,
	TFolder,
	TextComponent,
} from "obsidian";
import CodeFilesPlugin from "./main";
import { buildFlowchartModel, countByExtension } from "./flowchartModel";
import {
	AGGREGATE_INCLUDE_FLAG,
	GenerateResult,
	collectCanvasFiles,
	collectCanvasFilesUpToDepth,
	generateFlowcharts,
	isGeneratedSubflowchartPath,
	setTagFlag,
} from "./flowchartCanvas";
import { RegenerateResult, regenerateFromMetadata } from "./flowchartAggregate";
import {
	PointerGranularity,
	PointerResult,
	generatePointersInSubfolders,
	normalizePointerDepth,
	pointerTargetFolders,
} from "./pointerFiles";
import {
	FlowsValidation,
	createFlow as createFlowManifest,
	flowchartsFolderForPath,
	readFlows,
	sanitizeFlowName,
	setFlowMembership,
	validateFlows as validateFlowsManifest,
} from "./flowchartFlows";
import { findCanvasNode } from "./canvasNarrow";
import { isIgnoredFolderPath, parseIgnorePatterns } from "./folderIgnore";

/**
 * File-explorer + canvas-node context menus for the flowchart feature:
 *
 *   code folder ▸ "Generate flowcharts from code"    ▸ All enabled extensions / <ext>…
 *                 (writes the Subflowcharts/ sub-flowcharts only, with edge tags)
 *   folder containing canvases / canvas multi-selection ▸
 *                 "Generate aggregate flowchart from subflowchart metadata" —
 *                 rebuilds the codefile/subfolder canvases of the touched
 *                 flowchart trees from the symbol canvases' edge tags, then
 *                 composes each tree's flows.json flows into
 *                 main.canvas / main-<name>.canvas
 *   generated sub-flowchart (.canvas under flowcharts/Subflowcharts) ▸
 *                 "Include in flow ▸ <names…> / New flow…" and
 *                 "Exclude from flow ▸ <names…>" — edits the tree's flows.json
 *                 (see flowchartFlows.ts); also on canvas nodes, folder
 *                 recursive scans, and multi-selections
 *   any .canvas file / folder containing canvases / canvas multi-selection ▸
 *                 "Include in aggregate flowchart" / "Exclude from aggregate
 *                 flowchart" — toggles the "includeInAggregateFlowchart" tag
 *                 (any canvas, not just generated ones)
 *   any folder    ▸ "Include subset in aggregate flowchart" ▸ Depth 0 / 1 / 2
 *                   / 3 / 4 — same aggregate toggle (always turning inclusion
 *                   ON), scoped to canvases within N levels of subfolders
 *                   instead of the whole recursive scan (depth 0 = the
 *                   folder's own canvases only)
  *   any code folder ▸ "Generate pointers in subfolders" ▸ File granularity
  *                 / Symbol granularity — writes one generated `pointers.md`
  *                 into each eligible subfolder down to
  *                 "Pointer subfolder depth" levels (file: one `## {file}`
  *                 section per code file; symbol: one `## {file}#{symbol}`
  *                 section per linkable symbol, overwriting the same file)
  *                 with its consumer entries directly underneath; see
  *                 pointerFiles.ts and pointerConsumers.ts), so docs can point
  *                 at the generated file instead of hand-maintained file lists
 *
 * For a folder or multi-selection, if the aggregate-targeted canvases have
 * mixed include state, both "Include all" and "Exclude all" are offered
 * instead of a single toggle.
 *
 * Palette commands registered here: "Regenerate all flowcharts",
 * "Generate flowcharts from code…" (folder picker), "Generate aggregate
 * flowchart from subflowchart metadata…" (folder picker), and "Generate
 * pointers in subfolders…" (folder picker).
 *
 * Every FlowchartCommands method returns a plain-JSON result (also stashed on
 * `commands.lastResult`) for eval-driven workflows; Notices stay short
 * summaries.
 *
 * `generate`/`regenerate`/`regenerateAll` are serialized through an internal
 * promise-chain mutex (`runExclusive`) — overlapping runs race on
 * `vault.create` ("File already exists"), so queued jobs run strictly in call
 * order. `isRunning()`/`awaitIdle()` expose the job state so eval-driven
 * scripts can wait for idle instead of polling `lastResult`. Headless flow
 * management: `createFlow(folder, name)` pre-registers an empty flow in a
 * tree's flows.json (see flowchartFlows.ts), and `validateFlows(scope)`
 * reports flows.json member paths that no longer exist without composing
 * anything. `regenerateAll` takes an optional extension filter (default:
 * `settings.extensions`).
 *
 * Submenus use MenuItem.setSubmenu (runtime API since Obsidian 1.6; the bundled
 * typings predate it, hence the `as any`). If it is ever missing, items fall
 * back to flat entries with the extension in the title.
 */

export interface RegenerateAllTreeResult {
	flowchartsFolder: string;
	generated: GenerateResult | null;
	regenerated: RegenerateResult | null;
}

export interface RegenerateAllResult {
	trees: RegenerateAllTreeResult[];
}

export interface ValidateFlowsResult {
	trees: ({ flowchartsFolder: string } & FlowsValidation)[];
	/** Every missing member path across all trees (deduped, sorted). */
	missingCanvases: string[];
}

export interface FlowchartCommands {
	/** Plain-JSON result of the last command run (for eval-driven workflows). */
	lastResult: unknown;
	generate(folder: TFolder, extensions: string[]): Promise<GenerateResult | null>;
	regenerate(scope: TFolder | TFile[]): Promise<RegenerateResult | null>;
	regenerateAll(extensions?: string[]): Promise<RegenerateAllResult | null>;
	setAggregateIncluded(file: TFile, include: boolean): Promise<void>;
	setAggregateIncludedMany(files: TFile[], include: boolean): Promise<void>;
	setFlowMembership(files: TFile[], flowName: string, include: boolean): Promise<void>;
	/** Pre-register an empty flow in a tree's flows.json (headless "ensure flow"). */
	createFlow(
		flowchartsFolder: string,
		flowName: string,
	): Promise<{ name: string; created: boolean; flows: Record<string, string[]> } | null>;
	/** Read-only flows.json health check — reports missing member canvases without composing. */
	validateFlows(scope: TFolder | TFile[]): Promise<ValidateFlowsResult>;
	/**
	 * Writes a generated `pointers.md` into each immediate subfolder of
	 * `folder` (or into `folder` itself when it has no subfolders),
	 * overwriting whatever is there: file granularity writes one
	 * `## {file}` section per in-folder code file, symbol granularity
	 * writes one `## {file}#{symbol}` section per linkable symbol, both
	 * with their consumer entries directly underneath. Re-run after file
	 * renames instead of hand-maintaining per-doc file lists.
	 */
	generatePointers(folder: TFolder, extensions?: string[], granularity?: PointerGranularity): Promise<PointerResult | null>;
	/** True while a generate/regenerate job is running or queued (see runExclusive). */
	isRunning(): boolean;
	/** Resolves once no generate/regenerate job is running or queued. */
	awaitIdle(): Promise<void>;
}

export function setupFlowchartMenus(plugin: CodeFilesPlugin): FlowchartCommands {
	// Last-known aggregate include flags, for menu titles (sync menu building
	// cannot await file reads). Populated by the set* commands.
	const aggregateCache = new Map<string, boolean>();
	// Last-known flows per `…/flowcharts` folder, for the flow membership
	// submenus (same sync constraint). Refreshed by setFlowMembership and
	// fire-and-forget re-reads whenever a flow menu is built.
	const flowsCache = new Map<string, Record<string, string[]>>();

	const refreshFlowsCache = (folderPath: string): void => {
		void readFlows(plugin.app, folderPath).then((flows) => flowsCache.set(folderPath, flows));
	};

	const warnList = (message: string, paths: string[], timeout: number): void => {
		const list = paths.slice(0, 5).join(", ");
		const more = paths.length > 5 ? `, +${paths.length - 5} more` : "";
		const warning = new Notice(`${message}: ${list}${more}`, timeout);
		warning.noticeEl.addClass("mod-warning");
	};

	// Run-overlap guard: generate/regenerate/regenerateAll are serialized
	// through this promise chain — concurrent runs race on `vault.create`
	// for the same paths ("File already exists"). Queued jobs run strictly in
	// call order; `isRunning`/`awaitIdle` let eval-driven scripts wait for
	// idle instead of polling `lastResult`.
	let running = 0;
	let tail: Promise<unknown> = Promise.resolve();
	const idleResolvers: (() => void)[] = [];
	const runExclusive = <T>(job: () => Promise<T>): Promise<T> => {
		running++;
		const result = tail.then(job);
		tail = result.catch(() => undefined).then(() => {
			running--;
			if (running === 0) idleResolvers.splice(0).forEach((resolve) => resolve());
		});
		return result;
	};

	const commands: FlowchartCommands = {
		lastResult: null,

		async generate(folder, extensions) {
			return runExclusive(async () => {
				if (!requireAdvancedCanvas(plugin.app)) return null;
				const model = await buildFlowchartModel(plugin, folder, extensions);
				if (model.files.length === 0) {
					new Notice(`vscode-editor: no .${extensions.join("/.")} files found under ${folder.path}`);
					return null;
				}
				const result = await generateFlowcharts(plugin, model);
				commands.lastResult = result;
				new Notice(
					`vscode-editor: generated ${result.canvasCount} sub-flowcharts ` +
					`(${result.nodeCount} nodes, ${result.edgeCount} edges) from ${result.fileCount} files. ` +
					`Curate them with "Include in flow ▸", then run "Generate aggregate flowchart from subflowchart metadata".`,
				);
				if (result.renamedFiles.length > 0) {
					warnList(
						`vscode-editor: ${result.renamedFiles.length} generated name(s) collided with a sibling ` +
						`folder or another canvas and were renamed to stay unique (container/signature ` +
						`qualifier or occurrence number on a declaration canvas, "File" on the file's ` +
						`folder, " (kind)" on a basename match, "_" prefix otherwise)`,
						result.renamedFiles,
						10000,
					);
				}
				if (result.staleFiles.length > 0) {
					warnList(
						`vscode-editor: ${result.staleFiles.length} pre-existing canvas(es) under Subflowcharts ` +
						`were not written by this run (leftovers from an earlier naming scheme?). ` +
						`They were NOT deleted — review and remove them yourself`,
						result.staleFiles,
						0,
					);
				}
				if (result.prunedFiles.length > 0) {
					warnList(
						`vscode-editor: ${result.prunedFiles.length} stale generated canvas(es) (granularity-tagged, ` +
						`not rewritten by this run) were moved to the trash`,
						result.prunedFiles,
						10000,
					);
				}
				if (result.skipped.length > 0) {
					warnList(
						`vscode-editor: ${result.skipped.length} canvas(es) were skipped — their name still ` +
						`collided after 5 "_" prefixes`,
						result.skipped,
						0,
					);
				}
				return result;
			});
		},

		async regenerate(scope) {
			return runExclusive(async () => {
				if (!requireAdvancedCanvas(plugin.app)) return null;
				const result = await regenerateFromMetadata(plugin, scope);
				commands.lastResult = result;
				for (const flow of result.flows) {
					refreshFlowsCache(flow.path.split("/").slice(0, -1).join("/"));
				}
				if (result.written === 0 && result.flows.length === 0) {
					new Notice(
						"vscode-editor: no symbol-tagged canvases found in scope — run " +
							"\"Generate flowcharts from code\" first.",
					);
					return result;
				}
				const flowEdges = result.flows.reduce((a, f) => a + f.edgeCount, 0);
				new Notice(
					`vscode-editor: regenerated ${result.written} aggregate flowchart(s) ` +
					`(${result.edgeCount} edges) and composed ${result.flows.length} flow canvas(es) ` +
					`(${flowEdges} edges) across ${result.trees} tree(s).`,
				);
				if (result.missingCanvases.length > 0) {
					warnList(
						`vscode-editor: ${result.missingCanvases.length} canvas(es) listed in flows.json no longer ` +
						`exist and were skipped (flows.json was left untouched)`,
						result.missingCanvases,
						0,
					);
				}
				if (result.orphanedFlowCanvases.length > 0) {
					warnList(
						`vscode-editor: ${result.orphanedFlowCanvases.length} composed flow canvas(es) ` +
						`(main-*.canvas) no longer match any flow in flows.json (renamed/removed flow?). ` +
						`They were NOT deleted — review and remove them yourself`,
						result.orphanedFlowCanvases,
						0,
					);
				}
				return result;
			});
		},

		async regenerateAll(extensions) {
			return runExclusive(async () => {
				if (!requireAdvancedCanvas(plugin.app)) return null;
				const exts = extensions ?? plugin.settings.extensions;
				const ignoredFolders = parseIgnorePatterns(plugin.settings.ignoredFolders);
				const result: RegenerateAllResult = { trees: [] };
				// Strictly sequential — concurrent vault writes race.
				for (const flowchartsFolder of discoverFlowchartTrees(plugin.app, ignoredFolders)) {
					const parent = flowchartsFolder.parent;
					if (!parent) continue;
					const model = await buildFlowchartModel(plugin, parent, exts);
					const generated = model.files.length > 0 ? await generateFlowcharts(plugin, model) : null;
					const regenerated = await regenerateFromMetadata(plugin, flowchartsFolder);
					result.trees.push({ flowchartsFolder: flowchartsFolder.path, generated, regenerated });
					refreshFlowsCache(flowchartsFolder.path);
				}
				commands.lastResult = result;
				if (result.trees.length === 0) {
					new Notice("vscode-editor: no flowchart trees found (no `flowcharts` folder with a Subflowcharts tree or flows.json).");
					return result;
				}
				const canvases = result.trees.reduce((a, t) => a + (t.generated?.canvasCount ?? 0), 0);
				const flows = result.trees.reduce((a, t) => a + (t.regenerated?.flows.length ?? 0), 0);
				new Notice(
					`vscode-editor: regenerated ${result.trees.length} flowchart tree(s) ` +
					`(${canvases} sub-flowcharts, ${flows} flow canvases).`,
				);
				return result;
			});
		},

		async setAggregateIncluded(file, include) {
			await setTagFlag(plugin.app, file, AGGREGATE_INCLUDE_FLAG, include);
			aggregateCache.set(file.path, include);
			commands.lastResult = { flag: AGGREGATE_INCLUDE_FLAG, include, files: [file.path] };
			new Notice(
				`vscode-editor: ${file.name} ${include ? "included in" : "excluded from"} aggregate flowcharts.`,
			);
		},

		async setAggregateIncludedMany(files, include) {
			if (files.length === 0) return;
			for (const file of files) {
				await setTagFlag(plugin.app, file, AGGREGATE_INCLUDE_FLAG, include);
				aggregateCache.set(file.path, include);
			}
			commands.lastResult = { flag: AGGREGATE_INCLUDE_FLAG, include, files: files.map((f) => f.path) };
			const verb = include ? "included in" : "excluded from";
			new Notice(
				files.length === 1
					? `vscode-editor: ${files[0].name} ${verb} aggregate flowcharts.`
					: `vscode-editor: ${files.length} canvases ${verb} aggregate flowcharts.`,
			);
		},

		async setFlowMembership(files, flowName, include) {
			const name = sanitizeFlowName(flowName);
			if (!name) {
				new Notice("vscode-editor: invalid flow name.");
				return;
			}
			// Each canvas belongs to its own tree's flows.json.
			const byFolder = new Map<string, string[]>();
			for (const file of files) {
				const folderPath = flowchartsFolderForPath(file.path);
				if (!folderPath) continue;
				const group = byFolder.get(folderPath) ?? [];
				group.push(file.path);
				byFolder.set(folderPath, group);
			}
			for (const [folderPath, paths] of byFolder) {
				flowsCache.set(folderPath, await setFlowMembership(plugin.app, folderPath, name, paths, include));
			}
			const touched = [...byFolder.values()].reduce((a, b) => a + b.length, 0);
			commands.lastResult = { flow: name, include, files: files.map((f) => f.path) };
			const verb = include ? "included in" : "excluded from";
			new Notice(
				touched === 1
					? `vscode-editor: ${files[0].name} ${verb} flow "${name}".`
					: `vscode-editor: ${touched} sub-flowcharts ${verb} flow "${name}".`,
			);
		},

		async createFlow(flowchartsFolder, flowName) {
			const result = await createFlowManifest(plugin.app, flowchartsFolder, flowName);
			if (!result) {
				new Notice("vscode-editor: invalid flow name.");
				return null;
			}
			flowsCache.set(flowchartsFolder, result.flows);
			commands.lastResult = { flow: result.name, created: result.created, flowchartsFolder };
			new Notice(
				result.created
					? `vscode-editor: flow "${result.name}" registered in ${flowchartsFolder}/flows.json (no members yet).`
					: `vscode-editor: flow "${result.name}" already exists in ${flowchartsFolder}/flows.json.`,
			);
			return result;
		},

		async validateFlows(scope) {
			// Read-only — deliberately NOT runExclusive (nothing is written).
			const manifests = Array.isArray(scope)
				? scope.filter((f) => f.name === "flows.json" && f.parent?.name === "flowcharts")
				: collectFlowsManifests(scope);
			const result: ValidateFlowsResult = { trees: [], missingCanvases: [] };
			for (const manifest of manifests) {
				const folderPath = manifest.parent?.path;
				if (folderPath == null) continue;
				const report = await validateFlowsManifest(plugin.app, folderPath);
				result.trees.push({ flowchartsFolder: folderPath, ...report });
				result.missingCanvases.push(...report.missingCanvases);
			}
			result.missingCanvases = [...new Set(result.missingCanvases)].sort();
			commands.lastResult = result;
			if (result.trees.length === 0) {
				new Notice("vscode-editor: no flows.json manifests found in scope.");
			} else if (result.missingCanvases.length > 0) {
				warnList(
					`vscode-editor: ${result.missingCanvases.length} canvas(es) listed in flows.json no longer exist`,
					result.missingCanvases,
					0,
				);
			} else {
				const flowCount = result.trees.reduce((a, t) => a + t.flows.length, 0);
				new Notice(
					`vscode-editor: ${flowCount} flow(s) across ${result.trees.length} tree(s) OK — no missing canvases.`,
				);
			}
			return result;
		},

		async generatePointers(folder, extensions, granularity = "file") {
			return runExclusive(async () => {
				const result = await generatePointersInSubfolders(plugin, folder, extensions, granularity);
				commands.lastResult = result;
				if (result.written.length === 0) {
					new Notice("vscode-editor: no subfolders to write pointers into.");
				} else if (granularity === "symbol") {
					const symbols = result.targets.reduce((a, t) => a + (t.symbolCount ?? 0), 0);
					const consumers = result.targets.reduce((a, t) => a + (t.consumerSymbolCount ?? t.consumerCount), 0);
					new Notice(
						`vscode-editor: wrote ${result.written.length} symbol pointer file(s) ` +
						`(${symbols} symbol(s) indexed, ${consumers} consumer symbol link(s)). Re-run after renames — never hand-edit.`,
					);
				} else {
					const files = result.targets.reduce((a, t) => a + t.fileCount, 0);
					const consumers = result.targets.reduce((a, t) => a + t.consumerCount, 0);
					new Notice(
						`vscode-editor: wrote ${result.written.length} pointer file(s) ` +
						`(${files} code files indexed, ${consumers} consumer link(s)). Re-run after renames — never hand-edit.`,
					);
				}
				return result;
			});
		},

		isRunning() {
			return running > 0;
		},

		awaitIdle() {
			if (running === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idleResolvers.push(resolve));
		},
	};

	const aggregateSpec: IncludeToggleSpec = {
		flag: AGGREGATE_INCLUDE_FLAG,
		noun: "aggregate flowcharts",
		filter: (f) => f.extension === "canvas",
		setOne: (f, on) => commands.setAggregateIncluded(f, on),
		setMany: (fs, on) => commands.setAggregateIncludedMany(fs, on),
		cache: aggregateCache,
	};

	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFolder) {
				addFolderMenuItems(plugin, menu, file, commands);
				addPointerMenuItem(plugin, menu, file, commands);
				const canvases = collectCanvasFiles(file);
				addFlowMenuItems(plugin, menu, canvases, flowsCache, commands);
				addIncludeMenuItems(plugin, menu, canvases, aggregateSpec);
				addIncludeSubsetMenuItem(menu, file, aggregateSpec);
				if (canvases.length > 0) addRegenerateMenuItem(menu, file, commands);
				return;
			}
			if (file instanceof TFile && file.extension === "canvas") {
				addFlowMenuItems(plugin, menu, [file], flowsCache, commands);
				addIncludeMenuItems(plugin, menu, [file], aggregateSpec);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("files-menu", (menu, files) => {
			const tfiles = files.filter((f): f is TFile => f instanceof TFile);
			addFlowMenuItems(plugin, menu, tfiles, flowsCache, commands);
			addIncludeMenuItems(plugin, menu, tfiles, aggregateSpec);
			const canvases = tfiles.filter((f) => f.extension === "canvas");
			if (canvases.length > 0) addRegenerateMenuItem(menu, canvases, commands);
		}),
	);

	setupCanvasNodeIncludeMenu(plugin, aggregateSpec, flowsCache, commands);

	plugin.addCommand({
		id: "regenerate-all-flowcharts",
		name: "Regenerate all flowcharts",
		callback: () => void commands.regenerateAll(),
	});
	plugin.addCommand({
		id: "generate-flowcharts-from-code",
		name: "Generate flowcharts from code…",
		callback: () => {
			new FolderSuggestModal(plugin.app, (folder) =>
				void commands.generate(folder, plugin.settings.extensions),
			).open();
		},
	});
	plugin.addCommand({
		id: "generate-aggregate-flowchart-from-metadata",
		name: "Generate aggregate flowchart from subflowchart metadata…",
		callback: () => {
			new FolderSuggestModal(
				plugin.app,
				(folder) => void commands.regenerate(folder),
				(folder) => collectCanvasFiles(folder).length > 0,
			).open();
		},
	});
	plugin.addCommand({
		id: "generate-pointers-in-subfolders",
		name: "Generate pointers in subfolders…",
		callback: () => {
			new FolderSuggestModal(plugin.app, (folder) =>
				void commands.generatePointers(folder),
			).open();
		},
	});

	return commands;
}

// ---------- menu construction ----------

function addFolderMenuItems(
	plugin: CodeFilesPlugin,
	menu: Menu,
	folder: TFolder,
	commands: FlowchartCommands,
): void {
	const counts = countByExtension(
		folder,
		plugin.settings.extensions,
		plugin.settings.includeGeneratedCodeFiles,
		parseIgnorePatterns(plugin.settings.ignoredFolders),
	);
	if (counts.size === 0) return;
	const total = [...counts.values()].reduce((a, b) => a + b, 0);

	const extLabel = (ext: string) => `${ext} (${counts.get(ext)})`;

	menu.addItem((item) => {
		item.setTitle("Generate flowcharts from code").setIcon("workflow");
		withSubmenu(
			item,
			(sub) => {
				sub.addItem((subItem) =>
					subItem
						.setTitle(`All enabled extensions (${total})`)
						.setIcon("workflow")
						.onClick(() => void commands.generate(folder, plugin.settings.extensions)),
				);
				for (const ext of counts.keys()) {
					sub.addItem((subItem) =>
						subItem
							.setTitle(extLabel(ext))
							.onClick(() => void commands.generate(folder, [ext])),
					);
				}
			},
			// Flat fallback: "Generate flowcharts from code (rs)" etc.
			() => {
				menu.addItem((flat) =>
					flat
						.setTitle(`Generate flowcharts from code (all, ${total})`)
						.setIcon("workflow")
						.onClick(() => void commands.generate(folder, plugin.settings.extensions)),
				);
				for (const ext of counts.keys()) {
					menu.addItem((flat) =>
						flat
							.setTitle(`Generate flowcharts from code (${extLabel(ext)})`)
							.onClick(() => void commands.generate(folder, [ext])),
					);
				}
			},
		);
	});
}

function addRegenerateMenuItem(
	menu: Menu,
	scope: TFolder | TFile[],
	commands: FlowchartCommands,
): void {
	menu.addItem((item) =>
		item
			.setTitle("Generate aggregate flowchart from subflowchart metadata")
			.setIcon("workflow")
			.onClick(() => void commands.regenerate(scope)),
	);
}

/**
 * Folder context-menu item behind the generated pointer files (see
 * pointerFiles.ts): "Generate pointers in subfolders" ▸ File granularity /
 * Symbol granularity — writes one `pointers.md` into each eligible subfolder
 * down to `settings.pointerSubfolderDepth` levels (default: immediate
 * subfolders only; file granularity: one `## {file}` section per code file;
 * symbol granularity: one `## {file}#{symbol}` section per linkable
 * symbol, overwriting the same file), indexing its code and annotated
 * vault-wide consumers. Offered on any folder that has eligible subfolders
 * (or code files, so it also works on a single leaf module folder).
 * Ignored folders are skipped at every level.
 */
function addPointerMenuItem(
	plugin: CodeFilesPlugin,
	menu: Menu,
	folder: TFolder,
	commands: FlowchartCommands,
): void {
	const includeGenerated = plugin.settings.includeGeneratedCodeFiles;
	const ignoredFolders = parseIgnorePatterns(plugin.settings.ignoredFolders);
	const depth = normalizePointerDepth(plugin.settings.pointerSubfolderDepth);
	const targets = pointerTargetFolders(folder, includeGenerated, ignoredFolders, depth);
	if (targets.length === 0) {
		if (countByExtension(folder, plugin.settings.extensions, includeGenerated, ignoredFolders).size === 0) return;
	}
	const suffix = targets.length > 1 ? ` (${targets.length})` : "";
	menu.addItem((item) => {
		item.setTitle(`Generate pointers in subfolders${suffix}`).setIcon("link");
		withSubmenu(
			item,
			(sub) => {
				sub.addItem((subItem) =>
					subItem
						.setTitle("File granularity")
						.setIcon("link")
						.onClick(() => void commands.generatePointers(folder, undefined, "file")),
				);
				sub.addItem((subItem) =>
					subItem
						.setTitle("Symbol granularity")
						.setIcon("link")
						.onClick(() => void commands.generatePointers(folder, undefined, "symbol")),
				);
			},
			// Flat fallback: "Generate pointers in subfolders (file)" etc.
			() => {
				menu.addItem((flat) =>
					flat
						.setTitle(`Generate pointers in subfolders (file${suffix})`)
						.setIcon("link")
						.onClick(() => void commands.generatePointers(folder, undefined, "file")),
				);
				menu.addItem((flat) =>
					flat
						.setTitle(`Generate pointers in subfolders (symbol${suffix})`)
						.setIcon("link")
						.onClick(() => void commands.generatePointers(folder, undefined, "symbol")),
				);
			},
		);
	});
}

/**
 * Flow membership items for generated sub-flowchart canvases ("Include in
 * flow ▸" — every known flow plus "New flow…" — and "Exclude from flow ▸" —
 * only flows holding at least one target). Each tree's flows.json is edited
 * via `commands.setFlowMembership`; non-generated canvases are silently
 * dropped. Flow names come from a last-known cache (menu building is sync);
 * every menu build also kicks a re-read so the next open is current.
 */
function addFlowMenuItems(
	plugin: CodeFilesPlugin,
	menu: Menu,
	files: TFile[],
	flowsCache: Map<string, Record<string, string[]>>,
	commands: FlowchartCommands,
): void {
	const byFolder = new Map<string, TFile[]>();
	for (const f of files) {
		if (!isGeneratedSubflowchartPath(f.path)) continue;
		const folderPath = flowchartsFolderForPath(f.path);
		if (!folderPath) continue;
		const group = byFolder.get(folderPath) ?? [];
		group.push(f);
		byFolder.set(folderPath, group);
	}
	if (byFolder.size === 0) return;

	for (const [folderPath, group] of byFolder) {
		refreshFlowsCacheSoon(plugin, folderPath, flowsCache);
		const flows = flowsCache.get(folderPath) ?? {};
		const names = Object.keys(flows).sort();
		const suffix = group.length > 1 ? ` (${group.length})` : "";
		const include = (name: string) => void commands.setFlowMembership(group, name, true);
		const exclude = (name: string) => void commands.setFlowMembership(group, name, false);

		menu.addItem((item) => {
			item.setTitle(`Include in flow${suffix}`).setIcon("pin");
			withSubmenu(
				item,
				(sub) => {
					for (const name of names) {
						sub.addItem((subItem) => subItem.setTitle(name).onClick(() => include(name)));
					}
					sub.addItem((subItem) =>
						subItem
							.setTitle("New flow…")
							.setIcon("plus")
							.onClick(() => new NewFlowModal(plugin.app, include).open()),
					);
				},
				() => {
					for (const name of names) {
						menu.addItem((flat) =>
							flat.setTitle(`Include in flow "${name}"${suffix}`).onClick(() => include(name)),
						);
					}
					menu.addItem((flat) =>
						flat
							.setTitle(`Include in new flow…${suffix}`)
							.onClick(() => new NewFlowModal(plugin.app, include).open()),
					);
				},
			);
		});

		const groupPaths = new Set(group.map((f) => f.path));
		const excludable = names.filter((n) => (flows[n] ?? []).some((p) => groupPaths.has(p)));
		if (excludable.length === 0) continue;
		menu.addItem((item) => {
			item.setTitle(`Exclude from flow${suffix}`).setIcon("pin-off");
			withSubmenu(
				item,
				(sub) => {
					for (const name of excludable) {
						sub.addItem((subItem) => subItem.setTitle(name).onClick(() => exclude(name)));
					}
				},
				() => {
					for (const name of excludable) {
						menu.addItem((flat) =>
							flat.setTitle(`Exclude from flow "${name}"${suffix}`).onClick(() => exclude(name)),
						);
					}
				},
			);
		});
	}
}

/** Fire-and-forget flows.json re-read so the next menu build sees current flow names. */
function refreshFlowsCacheSoon(
	plugin: CodeFilesPlugin,
	folderPath: string,
	flowsCache: Map<string, Record<string, string[]>>,
): void {
	void readFlows(plugin.app, folderPath).then((flows) => flowsCache.set(folderPath, flows));
}

/** One include/exclude toggle family (the aggregate flag). */
interface IncludeToggleSpec {
	flag: string;
	/** Noun phrase for titles/notices: "aggregate flowcharts". */
	noun: string;
	/** Which of the input files the toggle applies to. */
	filter: (f: TFile) => boolean;
	setOne: (file: TFile, include: boolean) => Promise<void>;
	setMany: (files: TFile[], include: boolean) => Promise<void>;
	cache: Map<string, boolean>;
}

/**
 * Adds the include/exclude toggle for one or more canvases (files failing
 * `spec.filter` are silently dropped). A single target keeps the plain toggle
 * wording via `spec.setOne`; multiple targets go through `spec.setMany` and
 * get a count suffix. Mixed include state across multiple targets offers both
 * "Include all" and "Exclude all" instead of guessing which way to toggle.
 */
function addIncludeMenuItems(
	plugin: CodeFilesPlugin,
	menu: Menu,
	files: TFile[],
	spec: IncludeToggleSpec,
): void {
	const targets = files.filter(spec.filter);
	if (targets.length === 0) return;

	if (targets.length === 1) {
		const file = targets[0];
		const included = currentIncludeState(plugin, file, spec);
		menu.addItem((item) =>
			item
				.setTitle(included ? `Exclude from ${spec.noun}` : `Include in ${spec.noun}`)
				.setIcon(included ? "pin-off" : "pin")
				.onClick(() => void spec.setOne(file, !included)),
		);
		return;
	}

	const states = targets.map((f) => currentIncludeState(plugin, f, spec));
	const allIncluded = states.every((s) => s);
	const allExcluded = states.every((s) => !s);
	const suffix = ` (${targets.length})`;

	if (allIncluded) {
		menu.addItem((item) =>
			item
				.setTitle(`Exclude from ${spec.noun}${suffix}`)
				.setIcon("pin-off")
				.onClick(() => void spec.setMany(targets, false)),
		);
	} else if (allExcluded) {
		menu.addItem((item) =>
			item
				.setTitle(`Include in ${spec.noun}${suffix}`)
				.setIcon("pin")
				.onClick(() => void spec.setMany(targets, true)),
		);
	} else {
		menu.addItem((item) =>
			item
				.setTitle(`Include all in ${spec.noun}${suffix}`)
				.setIcon("pin")
				.onClick(() => void spec.setMany(targets, true)),
		);
		menu.addItem((item) =>
			item
				.setTitle(`Exclude all from ${spec.noun}${suffix}`)
				.setIcon("pin-off")
				.onClick(() => void spec.setMany(targets, false)),
		);
	}
}

const SUBSET_DEPTHS = [0, 1, 2, 3, 4];

/**
 * Adds "Include subset in <noun>" ▸ Depth 0 / 1 / 2 / 3 / 4 for a folder. Each
 * depth re-scans the folder (canvases keep changing between clicks, so this
 * can't reuse a scan done for `addIncludeMenuItems`) via
 * `collectCanvasFilesUpToDepth`, filters through `spec.filter`, and flips
 * every match's flag on via `spec.setMany` — always "include", never a
 * toggle, since the point is narrowing the recursive "include all" down to a
 * depth-bounded subset. No item is added when the folder holds no matching
 * canvases at any depth.
 */
function addIncludeSubsetMenuItem(menu: Menu, folder: TFolder, spec: IncludeToggleSpec): void {
	if (collectCanvasFiles(folder).filter(spec.filter).length === 0) return;

	menu.addItem((item) => {
		item.setTitle(`Include subset in ${spec.noun}`).setIcon("pin");
		withSubmenu(
			item,
			(sub) => {
				for (const depth of SUBSET_DEPTHS) {
					sub.addItem((subItem) =>
						subItem
							.setTitle(`Depth ${depth}`)
							.onClick(() => {
								const targets = collectCanvasFilesUpToDepth(folder, depth).filter(spec.filter);
								void spec.setMany(targets, true);
							}),
					);
				}
			},
			() => {
				for (const depth of SUBSET_DEPTHS) {
					menu.addItem((flat) =>
						flat
							.setTitle(`Include subset in ${spec.noun} (depth ${depth})`)
							.onClick(() => {
								const targets = collectCanvasFilesUpToDepth(folder, depth).filter(spec.filter);
								void spec.setMany(targets, true);
							}),
					);
				}
			},
		);
	});
}

/**
 * Best-effort synchronous read of an include flag: the metadata cache when it
 * indexes canvas frontmatter, otherwise the last-known cache. The flag lives
 * as a tag in `frontmatter.tags`, not a standalone boolean property.
 */
function currentIncludeState(
	plugin: CodeFilesPlugin,
	file: TFile,
	spec: IncludeToggleSpec,
): boolean {
	const fm = (plugin.app.metadataCache.getFileCache(file) as any)?.frontmatter;
	if (fm && typeof fm === "object") return Array.isArray(fm.tags) && fm.tags.includes(spec.flag);
	return spec.cache.get(file.path) ?? false;
}

function requireAdvancedCanvas(app: App): boolean {
	const enabled = !!(app as any).plugins?.plugins?.["advanced-canvas"];
	if (!enabled) {
		new Notice("vscode-editor: flowchart generation requires the Advanced Canvas plugin — install and enable it first.");
	}
	return enabled;
}

/**
 * Fills the item's submenu when the runtime supports it; otherwise runs
 * `flatFallback`, which adds flat items to the parent menu instead.
 */
function withSubmenu(
	item: MenuItem,
	fill: (submenu: Menu) => void,
	flatFallback: () => void,
): void {
	const anyItem = item as any;
	if (typeof anyItem.setSubmenu === "function") {
		fill(anyItem.setSubmenu());
	} else {
		flatFallback();
	}
}

// ---------- tree discovery / folder picking ----------

/** Every folder in the vault (the bundled typings predate `Vault.getAllFolders`). */
function allFolders(app: App): TFolder[] {
	const out: TFolder[] = [];
	const walk = (dir: TFolder) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) {
				out.push(child);
				walk(child);
			}
		}
	};
	walk(app.vault.getRoot());
	return out;
}

/**
 * Every `flowcharts` folder holding a generated tree: a `Subflowcharts`
 * child folder or a flows.json manifest. Trees inside an ignored folder are
 * skipped (`ignoredFolders` = `settings.ignoredFolders`).
 */
function discoverFlowchartTrees(app: App, ignoredFolders: string[] = []): TFolder[] {
	return allFolders(app).filter(
		(folder) =>
			folder.name === "flowcharts" &&
			!isIgnoredFolderPath(folder.path, ignoredFolders) &&
			folder.children.some(
				(c) =>
					(c instanceof TFolder && c.name === "Subflowcharts") ||
					(c instanceof TFile && c.name === "flows.json"),
			),
	);
}

/**
 * Every flows.json manifest under `folder` (recursive) whose parent is a
 * `flowcharts` folder, sorted by path. Backs `commands.validateFlows`.
 */
function collectFlowsManifests(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (dir: TFolder) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) {
				walk(child);
			} else if (child instanceof TFile && child.name === "flows.json" && dir.name === "flowcharts") {
				out.push(child);
			}
		}
	};
	walk(folder);
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Vault-folder picker for the palette commands. */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onChoose: (folder: TFolder) => void,
		private folderFilter?: (folder: TFolder) => boolean,
	) {
		super(app);
		this.setPlaceholder("Pick a folder");
	}

	getItems(): TFolder[] {
		const folders = allFolders(this.app);
		return this.folderFilter ? folders.filter(this.folderFilter) : folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

/** Tiny prompt for a new flow name (sanitized before use). */
class NewFlowModal extends Modal {
	private name = "";

	constructor(app: App, private onSubmit: (name: string) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const input = new TextComponent(contentEl);
		input.setPlaceholder("New flow name");
		input.onChange((value) => (this.name = value));
		input.inputEl.addEventListener("keypress", (e) => {
			if (e.key === "Enter") this.complete();
		});
		const button = new ButtonComponent(contentEl);
		button.setCta();
		button.setButtonText("Create");
		button.onClick(() => this.complete());
		input.inputEl.focus();
	}

	private complete() {
		const name = sanitizeFlowName(this.name);
		this.close();
		if (!name) {
			new Notice("vscode-editor: invalid flow name (empty after stripping #:[]|\\/^).");
			return;
		}
		this.onSubmit(name);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------- canvas node context menu ----------

/**
 * Offers the flow membership items (generated sub-flowchart nodes) and the
 * aggregate include/exclude toggle (any .canvas node) on canvas nodes. Same
 * injection pattern as canvasNarrow's node menu: a capture-phase contextmenu
 * listener finds the node and wraps its class's showMenu once per prototype.
 */
function setupCanvasNodeIncludeMenu(
	plugin: CodeFilesPlugin,
	aggregateSpec: IncludeToggleSpec,
	flowsCache: Map<string, Record<string, string[]>>,
	commands: FlowchartCommands,
): void {
	const patched: { proto: any; original: Function }[] = [];

	plugin.registerDomEvent(document, "contextmenu", (evt) => {
		const nodeEl = (evt.target as HTMLElement | null)?.closest?.(".canvas-node");
		if (!(nodeEl instanceof HTMLElement)) return;
		const node = findCanvasNode(plugin.app, nodeEl);
		if (!node || node.__proto__.__vscodeEditorFlowchartMenuPatched) return;

		const proto = node.__proto__;
		const original = proto.showMenu;
		if (typeof original !== "function") return;

		proto.__vscodeEditorFlowchartMenuPatched = true;
		proto.showMenu = function (menu: Menu) {
			original.call(this, menu);
			const file = this.file;
			if (!(file instanceof TFile)) return;
			addFlowMenuItems(plugin, menu, [file], flowsCache, commands);
			addIncludeMenuItems(plugin, menu, [file], aggregateSpec);
		};
		patched.push({ proto, original });
	}, { capture: true });

	plugin.register(() => {
		for (const { proto, original } of patched) {
			proto.showMenu = original;
			delete proto.__vscodeEditorFlowchartMenuPatched;
		}
	});
}
