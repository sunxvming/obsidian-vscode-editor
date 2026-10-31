import { App, Menu, Notice, SuggestModal, TFile, prepareFuzzySearch, setIcon, setTooltip } from "obsidian";
import CodeFilesPlugin from "./main";
import { isSymbolCapableExtension, SymbolInfo } from "./symbolResolver";

/**
 * Adds "Narrow to symbol…" / "Show whole file" items to the canvas node's
 * context menu for symbol-capable code files.
 *
 * Canvas file nodes render through the plugin's embedRegistry creator
 * (CodeFileEmbed), which already understands `#symbol` subpaths — so
 * narrowing is just a matter of setting `node.subpath` and re-rendering:
 *
 *   node.setData({ ...node.getData(), subpath: "#Fn" });
 *   node.render();               // re-creates the embed child with the subpath
 *   node.canvas.requestSave();
 *
 * There is no public API for extending a canvas node's menu, so the node
 * class's `showMenu` is wrapped lazily: a capture-phase contextmenu listener
 * (registered before the canvas's own handler runs) locates the node object
 * under the cursor and patches its prototype exactly once, so even the first
 * right-click gets the extra items.
 */
export function setupCanvasNarrowing(plugin: CodeFilesPlugin) {
	const patched: { proto: any; original: Function }[] = [];

	plugin.registerDomEvent(document, "contextmenu", (evt) => {
		const nodeEl = (evt.target as HTMLElement | null)?.closest?.(".canvas-node");
		if (!(nodeEl instanceof HTMLElement)) return;
		const node = findCanvasNode(plugin.app, nodeEl);
		if (!node || node.__proto__.__vscodeEditorMenuPatched) return;

		const proto = node.__proto__;
		const original = proto.showMenu;
		if (typeof original !== "function") return;

		proto.__vscodeEditorMenuPatched = true;
		proto.showMenu = function (menu: Menu) {
			original.call(this, menu);
			addNarrowMenuItems(plugin, menu, this);
		};
		patched.push({ proto, original });
	}, { capture: true });

	plugin.register(() => {
		for (const { proto, original } of patched) {
			proto.showMenu = original;
			delete proto.__vscodeEditorMenuPatched;
		}
	});
}

/**
 * The canvas background menu's "Add note from vault" search only lists
 * markdown files. Injects an "Add code file from vault…" item next to it that
 * opens the same style of search over the plugin's enabled extensions and
 * drops the chosen file as a node where the user right-clicked.
 *
 * The background menu is built inside the canvas's private onContextMenu, so
 * the injection point is Menu.prototype.showAtMouseEvent: by the time a menu
 * is shown its items already exist, and a menu containing "Add note from
 * vault" is identifiable as the canvas background menu.
 */
export function setupCanvasAddCodeFile(plugin: CodeFilesPlugin) {
	const original = Menu.prototype.showAtMouseEvent;
	Menu.prototype.showAtMouseEvent = function (evt: MouseEvent) {
		try {
			maybeInjectAddCodeFile(plugin, this, evt);
		} catch (e) {
			console.error("vscode-editor: failed to inject canvas menu item", e);
		}
		return original.call(this, evt);
	};
	plugin.register(() => {
		Menu.prototype.showAtMouseEvent = original;
	});
}

const ADD_CODE_FILE_TITLE = "Add code file from vault…";

function maybeInjectAddCodeFile(plugin: CodeFilesPlugin, menu: Menu, evt: MouseEvent) {
	const items = (menu as any).items as any[] | undefined;
	if (!items) return;
	if (!items.some((i) => i.titleEl?.textContent === "Add note from vault")) return;
	if (items.some((i) => i.titleEl?.textContent === ADD_CODE_FILE_TITLE)) return;

	menu.addItem((item) =>
		item
			.setTitle(ADD_CODE_FILE_TITLE)
			.setIcon("file-code")
			.onClick(() => {
				const canvas = findCanvasForEvent(plugin.app, evt);
				if (!canvas) return;
				const pos = canvas.posFromEvt(evt);
				new CodeFileSuggestModal(plugin, (file) => {
					canvas.createFileNode({
						file,
						pos,
						size: {
							width: plugin.settings.canvasNodeWidth,
							height: plugin.settings.canvasNodeHeight,
						},
					});
					canvas.requestSave();
				}).open();
			})
	);
}

function findCanvasForEvent(app: App, evt: MouseEvent): any {
	let found: any = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (found) return;
		const canvas = (leaf.view as any)?.canvas;
		if (!canvas) return;
		// Prefer the canvas whose element contains the right-click target…
		if (canvas.wrapperEl?.contains(evt.target as Node)) {
			found = canvas;
			return;
		}
		// …otherwise remember the first canvas as a fallback.
		if (!found) found = canvas;
	});
	return found;
}

/**
 * Adds a "Drag to add code file" button to the canvas's native bottom card
 * menu (the same floating control that offers Text/File/Link/Group), so code
 * files don't require a right-click to add.
 *
 * `cardMenuEl`, `dragTempNode`, `createFileNode`, and `getViewportBBox` are
 * native (undocumented) Canvas APIs — the button is a plain
 * `div.canvas-card-menu-button.mod-draggable`, which Obsidian's own CSS
 * already styles like the built-in buttons, so no custom styles are needed.
 * There's no event for "a canvas view's card menu is ready", so the button is
 * (re)applied on `active-leaf-change` and `layout-change`, which cover
 * switching into a canvas tab, opening new panes/splits, and a canvas view
 * rebuilding its card menu (e.g. on file swap). No prototype patching.
 */
export function setupCanvasCardMenuButton(plugin: CodeFilesPlugin) {
	const applyToAll = () => {
		for (const leaf of plugin.app.workspace.getLeavesOfType("canvas")) {
			ensureAddCodeFileCardMenuButton(plugin, (leaf.view as any)?.canvas);
		}
	};

	applyToAll(); // canvases already open when the plugin loads
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", applyToAll));
	plugin.registerEvent(plugin.app.workspace.on("layout-change", applyToAll));
}

const CARD_MENU_BUTTON_ID = "vscode-editor-add-code-file";

function ensureAddCodeFileCardMenuButton(plugin: CodeFilesPlugin, canvas: any) {
	if (!canvas?.cardMenuEl) return;
	canvas.cardMenuEl.querySelector(`#${CARD_MENU_BUTTON_ID}`)?.remove();
	canvas.cardMenuEl.appendChild(createAddCodeFileCardMenuButton(plugin, canvas));
}

function createAddCodeFileCardMenuButton(plugin: CodeFilesPlugin, canvas: any): HTMLElement {
	const el = document.createElement("div");
	el.id = CARD_MENU_BUTTON_ID;
	el.classList.add("canvas-card-menu-button", "mod-draggable");
	setIcon(el, "file-code");
	setTooltip(el, "Drag to add code file", { placement: "top" });

	const nodeSize = () => ({
		width: plugin.settings.canvasNodeWidth,
		height: plugin.settings.canvasNodeHeight,
	});

	const place = (pos: { x: number; y: number }) => {
		canvas.deselectAll();
		new CodeFileSuggestModal(plugin, (file) => {
			canvas.createFileNode({ file, pos, size: nodeSize() });
			canvas.requestSave();
		}).open();
	};

	el.addEventListener("click", () => place(getViewportCenterPos(canvas, nodeSize())));
	el.addEventListener("pointerdown", (e) => canvas.dragTempNode(e, nodeSize(), place));

	return el;
}

function getViewportCenterPos(canvas: any, size: { width: number; height: number }) {
	const b = canvas.getViewportBBox();
	return {
		x: (b.minX + b.maxX) / 2 - size.width / 2,
		y: (b.minY + b.maxY) / 2 - size.height / 2,
	};
}

function addNarrowMenuItems(plugin: CodeFilesPlugin, menu: Menu, node: any) {
	const file = node.file;
	if (!file || !isSymbolCapableExtension(file.extension)) return;
	if (!plugin.settings.extensions.includes(file.extension)) return;

	menu.addItem((item) =>
		item
			.setTitle("Narrow to symbol…")
			.setIcon("crosshair")
			.onClick(async () => {
				const content = await plugin.app.vault.cachedRead(file);
				const symbols = await plugin.symbolResolver.listSymbols(
					content, file.extension, plugin.settings.linkableSymbolKinds
				);
				if (symbols.length === 0) {
					new Notice(`vscode-editor: no symbols found in ${file.name}`);
					return;
				}
				new SymbolSuggestModal(plugin.app, symbols, (symbol) => {
					const subpath = symbol.occurrence > 1
						? `#${symbol.name}#${symbol.occurrence}`
						: `#${symbol.name}`;
					applySubpath(node, subpath);
				}).open();
			})
	);

	if (node.subpath) {
		menu.addItem((item) =>
			item
				.setTitle("Show whole file")
				.setIcon("file")
				.onClick(() => applySubpath(node, null))
		);
	}
}

function applySubpath(node: any, subpath: string | null) {
	const data = node.getData();
	if (subpath) {
		data.subpath = subpath;
	} else {
		delete data.subpath;
	}
	node.setData(data);
	node.render();
	node.canvas.requestSave();
}

export function findCanvasNode(app: App, nodeEl: HTMLElement): any {
	let found: any = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (found) return;
		const canvas = (leaf.view as any)?.canvas;
		if (!canvas?.nodes) return;
		for (const node of canvas.nodes.values()) {
			if (node.nodeEl === nodeEl) {
				found = node;
				return;
			}
		}
	});
	return found;
}

class CodeFileSuggestModal extends SuggestModal<TFile> {
	private plugin: CodeFilesPlugin;
	private onChoose: (file: TFile) => void;

	constructor(plugin: CodeFilesPlugin, onChoose: (file: TFile) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onChoose = onChoose;
		this.setPlaceholder("Add code file from vault…");
	}

	getSuggestions(query: string): TFile[] {
		const files = this.plugin.app.vault
			.getFiles()
			.filter((f) => this.plugin.settings.extensions.includes(f.extension))
			.sort((a, b) => a.path.localeCompare(b.path));
		if (!query) return files;
		const fuzzy = prepareFuzzySearch(query);
		return files.filter((f) => fuzzy(f.name) || fuzzy(f.path));
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.createSpan({ text: file.name });
		el.createSpan({
			cls: "vscode-editor-function-suggest-line",
			text: file.parent?.path && file.parent.path !== "/" ? file.parent.path : "",
		});
	}

	onChooseSuggestion(file: TFile): void {
		this.onChoose(file);
	}
}

class SymbolSuggestModal extends SuggestModal<SymbolInfo> {
	private symbols: SymbolInfo[];
	private onChoose: (symbol: SymbolInfo) => void;

	constructor(app: App, symbols: SymbolInfo[], onChoose: (symbol: SymbolInfo) => void) {
		super(app);
		this.symbols = symbols;
		this.onChoose = onChoose;
		this.setPlaceholder("Narrow to symbol…");
	}

	getSuggestions(query: string): SymbolInfo[] {
		const fuzzy = prepareFuzzySearch(query);
		return this.symbols.filter((s) => fuzzy(this.getItemText(s)));
	}

	getItemText(item: SymbolInfo): string {
		return item.occurrence > 1 ? `${item.name} #${item.occurrence}` : item.name;
	}

	renderSuggestion(item: SymbolInfo, el: HTMLElement): void {
		el.createSpan({ text: this.getItemText(item) });
		el.createSpan({
			cls: "vscode-editor-function-suggest-line",
			text: `${item.kind !== "function" ? `${item.kind} ` : ""}:${item.startLine}`,
		});
	}

	onChooseSuggestion(item: SymbolInfo): void {
		this.onChoose(item);
	}
}
