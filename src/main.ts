import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, EditorSettings } from "./common";
import { CodeEditorView } from "./codeEditorView";
import { CreateCodeFileModal } from "./createCodeFileModal";
import { CodeFilesSettingsTab } from "./codeFilesSettingsTab";
import { viewType } from "./common";
import { t } from 'src/lang/helpers';
import { FenceEditModal } from "./fenceEditModal";
import { FenceEditContext } from "./fenceEditContext";
import { mountCodeEditor } from "./mountCodeEditor";

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
	registeredExtensions: string[] = [];

	observer: MutationObserver;

	public hover: {
		linkText: string;
		sourcePath: string;
		event: MouseEvent;
	} = {
			linkText: "",
			sourcePath: "",
			event: new MouseEvent(""),
		};

	normalizeExtensions(extensions: string[]): string[] {
		return [...new Set(
			extensions
				.map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
				.filter(Boolean)
		)];
	}

	isCodeFile(file: TFile | null | undefined): file is TFile {
		if (!file) {
			return false;
		}

		return this.settings.extensions.includes(file.extension.toLowerCase());
	}

	async openCodeFile(file: TFile, leaf: WorkspaceLeaf = this.app.workspace.getLeaf(true)) {
		await leaf.setViewState({
			type: viewType,
			active: true,
			state: {
				file: file.path,
			},
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	registerConfiguredExtensions() {
		this.registeredExtensions = [];
		const skippedExtensions: string[] = [];

		for (const extension of this.settings.extensions) {
			try {
				this.registerExtensions([extension], viewType);
				this.registeredExtensions.push(extension);
			} catch (error) {
				skippedExtensions.push(extension);
				console.warn(`[vscode-editor] Skipping extension "${extension}" because another handler already registered it.`, error);
			}
		}

		if (this.registeredExtensions.length === 0 && skippedExtensions.length > 0) {
			new Notification(t("REGISTE_ERROR"), {
				body: t("REGISTE_ERROR_DESC", `No extensions could be registered. Conflicts: ${skippedExtensions.join(", ")}`)
			});
		}
	}

	async onload() {
		await this.loadSettings();

		this.registerView(viewType, leaf => new CodeEditorView(leaf, this));
		this.registerConfiguredExtensions();


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
			this.app.workspace.on("file-open", async (file) => {
				if (!this.isCodeFile(file)) {
					return;
				}

				const leaf = this.app.workspace.activeLeaf;
				if (!leaf || leaf.view.getViewType() === viewType) {
					return;
				}

				await this.openCodeFile(file, leaf);
			})
		);

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
			const file = this.app.metadataCache.getFirstLinkpathDest(this.hover.linkText, this.hover.sourcePath);
			if (!file) return;
			// check file.extension in this.settings.extensions array
			let valid = this.settings.extensions.includes(file.extension);
			if (valid === false) return;
			const fileContent = await this.app.vault.read(file);

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
	}



	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.extensions = this.normalizeExtensions(this.settings.extensions);
	}

	async saveSettings() {
		this.settings.extensions = this.normalizeExtensions(this.settings.extensions);
		await this.saveData(this.settings);
	}

}
