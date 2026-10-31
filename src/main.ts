import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, EditorSettings } from "./common";
import { CodeEditorView } from "./codeEditorView";
import { CreateCodeFileModal } from "./createCodeFileModal";
import { CodeFilesSettingsTab } from "./codeFilesSettingsTab";
import { viewType } from "./common";
import { t } from 'src/lang/helpers';
import { FenceEditModal } from "./fenceEditModal";
import { FenceEditContext } from "./fenceEditContext";
import { mountCodeEditor } from "./mountCodeEditor";
import { registerCodeEmbedCreators } from "./codeEmbed";
import { SymbolResolver, parseCodeSubpath, isSymbolCapableExtension } from "./symbolResolver";
import { CodeFunctionSuggest } from "./functionSuggest";
import { setupCanvasNarrowing, setupCanvasAddCodeFile, setupCanvasCardMenuButton } from "./canvasNarrow";
import { FlowchartCommands, setupFlowchartMenus } from "./flowchartMenu";

declare module "obsidian" {
	interface Workspace {
		on(
			name: "hover-link",
			callback: (e: MouseEvent) => any,
			ctx?: any,
		): EventRef;
	}
}


export default class CodeFilesPlugin extends Plugin {
	settings: EditorSettings;

	observer: MutationObserver;

	symbolResolver: SymbolResolver;

	flowchart: FlowchartCommands;

	public hover: {
		linkText: string;
		sourcePath: string;
		event: MouseEvent;
	} = {
			linkText: "",
			sourcePath: "",
			event: new MouseEvent(""),
		};

	async onload() {
		await this.loadSettings();

		this.symbolResolver = new SymbolResolver(this.app, this.manifest.dir ?? "");
		registerCodeEmbedCreators(this);
		setupCanvasNarrowing(this);
		setupCanvasAddCodeFile(this);
		setupCanvasCardMenuButton(this);
		this.flowchart = setupFlowchartMenus(this);

		// Symbol suggestions for [[file.cs#… — moved to the front of the
		// internal suggest list so it wins over core's heading suggest (which
		// would otherwise swallow the trigger for non-markdown files).
		const functionSuggest = new CodeFunctionSuggest(this);
		this.registerEditorSuggest(functionSuggest);
		const suggests = (this.app.workspace as any).editorSuggest?.suggests;
		if (Array.isArray(suggests)) {
			const i = suggests.indexOf(functionSuggest);
			if (i > 0) {
				suggests.splice(i, 1);
				suggests.unshift(functionSuggest);
			}
		}

		this.registerView(viewType, leaf => new CodeEditorView(leaf, this));

		try {
			this.registerExtensions(this.settings.extensions, viewType);
		} catch (e) {
			let exts = this.settings.extensions.join(", ")
			new Notification(t("REGISTE_ERROR"), {
				body: t("REGISTE_ERROR_DESC", e.message)
			});
		}


		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item
						.setTitle(t("CREATE_CODE"))
						.setIcon("file-json")
						.onClick(async () => {
							new CreateCodeFileModal(this, file).open();
						});
				});
			})
		);

		this.addRibbonIcon('file-json', t("CREATE_CODE"), () => {
			new CreateCodeFileModal(this).open();
		});

		this.addCommand({
			id: 'create',
			name: 'Create new code file',
			callback: () => {
				new CreateCodeFileModal(this).open();
			}
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu) => {
				if (!FenceEditContext.create(this).isInFence()) {
					return;
				}
				menu.addItem((item) => {
					item.setTitle(t("EDIT_FENCE"))
						.setIcon("code")
						.onClick(() => {
							FenceEditModal.openOnCurrentCode(this);
						});
				});
			})
		);



		//internal links
		this.observer = new MutationObserver(async (mutation) => {
			if (mutation.length !== 1) return;
			if (mutation[0].addedNodes.length !== 1) return;
			if (this.hover.linkText === null) return;
			//@ts-ignore
			if (mutation[0].addedNodes[0].className !== "popover hover-popover") return;
			const { linkpath, symbol, occurrence } = parseCodeSubpath(this.hover.linkText);
			const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, this.hover.sourcePath);
			if (!file) return;
			// check file.extension in this.settings.extensions array
			let valid = this.settings.extensions.includes(file.extension);
			if (valid === false) return;
			let fileContent = await this.app.vault.read(file);

			if (symbol && isSymbolCapableExtension(file.extension)) {
				const symbolRange = await this.symbolResolver.findSymbol(
					fileContent, file.extension, symbol, occurrence, this.settings.linkableSymbolKinds
				);
				if (symbolRange) {
					fileContent = symbolRange.text;
				}
			}

			const node: Node = mutation[0].addedNodes[0];
			const contentEl = createDiv();
			new mountCodeEditor(
				contentEl,
				this,
				fileContent,
				file.extension,
				false,
				true
			);

			let w = 700;
			let h = 500;
			let gep = 10;
			if (node instanceof HTMLDivElement) {
				let x = this.hover.event.clientX;
				let y = this.hover.event.clientY;
				let target = this.hover.event.target as HTMLElement;
				let targetRect = target.getBoundingClientRect();
				let targetTop = targetRect.top;
				let targetBottom = targetRect.bottom;
				let targeRight = targetRect.right
				node.style.position = "absolute";
				node.style.left = `${x + gep}px`;

				let spaceBelow = window.innerHeight - y - gep * 3;
				let spaceAbove = y - gep * 3;
				if (spaceBelow > h) {
					node.style.top = `${targetBottom + gep}px`;
				} else if (spaceAbove > h) {
					node.style.top = `${targetTop - h - gep}px`;
				} else {
					node.style.top = `${targetTop - (h / 2) - gep}px`;
					node.style.left = `${targeRight + gep * 2}px`;
				}
			}

			contentEl.setCssProps({
				"width": `${w}px`,
				"height": `${h}px`,
				"padding-top": "10px",
				"padding-bottom": "10px",
			});

			node.empty();
			node.appendChild(contentEl);

		});

		this.registerEvent(this.app.workspace.on("hover-link", async (event: any) => {
			const linkText: string = event.linktext;
			const sourcePath: string = event.sourcePath;
			if (!linkText || !sourcePath) return;
			this.hover.linkText = linkText;
			this.hover.sourcePath = sourcePath;
			this.hover.event = event.event;
		}));

		this.observer.observe(document, { childList: true, subtree: true });

		this.addSettingTab(new CodeFilesSettingsTab(this.app, this));
	}

	onunload() {
		this.observer.disconnect();
		// Free the long-lived tree-sitter parsers (see SymbolResolver.parsers).
		this.symbolResolver?.dispose();
	}



	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}
