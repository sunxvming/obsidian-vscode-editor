import { App, PluginSettingTab, Setting } from "obsidian";
import CodeFilesPlugin from "./main";
import { SymbolKind } from "./symbolResolver";
import { parseIgnorePatterns } from "./folderIgnore";
import { normalizePointerDepth } from "./pointerFiles";
import { t } from 'src/lang/helpers';


import {
	THEME_COLOR
} from "./constants";

export class CodeFilesSettingsTab extends PluginSettingTab {
	plugin: CodeFilesPlugin;

	constructor(app: App, plugin: CodeFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: t('CODE_SETTING') });


		new Setting(containerEl)
			.setName(t("BASE_COLOR"))
			.setDesc(t('BASE_COLOR_DESC'))
			.addDropdown(async (dropdown) => {
				for (const key in THEME_COLOR) {
					// @ts-ignore
					dropdown.addOption(key, t(key));
				}
				dropdown.setValue(this.plugin.settings.themeColor);
				dropdown.onChange(async (option) => {
					this.plugin.settings.themeColor = option;
					await this.plugin.saveSettings();
				});
			});

		let fontSizeText: HTMLDivElement;
		new Setting(containerEl)
			.setName(t('FONT_SIZE'))
			.setDesc(t('FONT_SIZE_DESC'))
			.addSlider(slider => slider
				.setLimits(5, 30, 1)
				.setValue(this.plugin.settings.fontSize)
				.onChange(async (value) => {
					fontSizeText.innerText = " " + value.toString();
					this.plugin.settings.fontSize = value;
					this.plugin.saveSettings();
				}))
			.settingEl.createDiv('', (el) => {
				fontSizeText = el;
				el.style.minWidth = "2.3em";
				el.style.textAlign = "right";
				el.innerText = " " + this.plugin.settings.fontSize.toString();
			});

		new Setting(containerEl)
			.setName(t('FONT_FAMILY'))
			.setDesc(t('FONT_FAMILY_DESC'))
			.addTextArea(text => text
				.setValue(this.plugin.settings.fontFamily)
				.onChange(async (value) => {
					this.plugin.settings.fontFamily = value;
					await this.plugin.saveSettings();
				})).setClass("setting_ext");

		new Setting(containerEl)
			.setName(t('FONT_LIGATURES'))
			.setDesc(t('FONT_LIGATURES_DESC'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.fontLigatures)
				.onChange(async (value) => {
					this.plugin.settings.fontLigatures = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('FILE_EXTENSIONS'))
			.setDesc(t('FILE_EXTENSIONS_DESC'))
			.addTextArea(text => text
				.setValue(this.plugin.settings.extensions.join(","))
				.onChange(async (value) => {
					this.plugin.settings.extensions = value.split(",");
					await this.plugin.saveSettings();
				})).setClass("setting_ext");


		new Setting(containerEl)
			.setName(t('WORDWRAP'))
			.setDesc(t('WORDWRAP_DESC'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.wordWrap)
				.onChange(async (value) => {
					this.plugin.settings.wordWrap = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('MINIMAP'))
			.setDesc(t('MINIMAP_DESC'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.minimap)
				.onChange(async (value) => {
					this.plugin.settings.minimap = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('LINE_NUMBERS'))
			.setDesc(t('LINE_NUMBERS_DESC'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.lineNumbers)
				.onChange(async (value) => {
					this.plugin.settings.lineNumbers = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName(t('FOLDING'))
			.setDesc(t('FOLDING_DESC'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.folding)
				.onChange(async (value) => {
					this.plugin.settings.folding = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('CANVAS_NODE_WIDTH'))
			.setDesc(t('CANVAS_NODE_WIDTH_DESC'))
			.addText(text => text
				.setValue(this.plugin.settings.canvasNodeWidth.toString())
				.onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed <= 0) return;
					this.plugin.settings.canvasNodeWidth = parsed;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('CANVAS_NODE_HEIGHT'))
			.setDesc(t('CANVAS_NODE_HEIGHT_DESC'))
			.addText(text => text
				.setValue(this.plugin.settings.canvasNodeHeight.toString())
				.onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed <= 0) return;
					this.plugin.settings.canvasNodeHeight = parsed;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('EMBED_HEADER'))
			.setDesc(t('EMBED_HEADER_DESC'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showEmbedHeader)
				.onChange(async (value) => {
					this.plugin.settings.showEmbedHeader = value;
					await this.plugin.saveSettings();
				}));


		containerEl.createEl('h2', { text: 'Symbol links' });

		const SYMBOL_KIND_LABELS: { kind: SymbolKind; label: string; desc: string }[] = [
			{ kind: "function", label: "Functions", desc: "Methods, constructors, local functions." },
			{ kind: "variable", label: "Variables", desc: "Class/global fields (C#), statics and consts (Rust)." },
			{ kind: "enum", label: "Enums", desc: "Enum declarations." },
			{ kind: "struct", label: "Structs", desc: "Struct declarations." },
			{ kind: "class", label: "Classes", desc: "Class declarations (C#)." },
			{ kind: "interface", label: "Interfaces", desc: "Interfaces (C#) and traits (Rust)." },
		];
		for (const { kind, label, desc } of SYMBOL_KIND_LABELS) {
			new Setting(containerEl)
				.setName(label)
				.setDesc(desc)
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.linkableSymbolKinds.includes(kind))
					.onChange(async (value) => {
						const kinds = this.plugin.settings.linkableSymbolKinds;
						if (value && !kinds.includes(kind)) {
							kinds.push(kind);
						} else if (!value) {
							this.plugin.settings.linkableSymbolKinds = kinds.filter((k) => k !== kind);
						}
						await this.plugin.saveSettings();
					}));
		}


		containerEl.createEl('h2', { text: 'Code scanning' });

		new Setting(containerEl)
			.setName('Ignored folders')
			.setDesc(
				'Folders skipped by every code scan — flowchart generation and "Generate pointers in subfolders" ' +
				'(ignored folders are neither indexed nor listed as consumers). One pattern per line, or comma-separated. ' +
				'A bare name matches that folder at any depth (`target` skips every `target/`); a path matches that spot ' +
				'(`server/target`); `*` matches within one segment (`client/*/bindings`) and `**` across segments. ' +
				'Case-insensitive. `node_modules`, `flowcharts`, `module_bindings` and dot-folders are always skipped.',
			)
			.addTextArea(text => text
				.setValue(parseIgnorePatterns(this.plugin.settings.ignoredFolders).join("\n"))
				.setPlaceholder('target\nbuild\nbindings\ndocs/AI/REFERENCES')
				.onChange(async (value) => {
					this.plugin.settings.ignoredFolders = parseIgnorePatterns(value);
					await this.plugin.saveSettings();
				}))
			.setClass("setting_ext");

		new Setting(containerEl)
			.setName('Pointer subfolder depth')
			.setDesc(
				'How many levels of subfolders "Generate pointers in subfolders" writes a `pointers.md` into. ' +
				'1 = the command folder\'s immediate subfolders only (default); 2 = those plus their subfolders; and so on, ' +
				'up to 16. Ignored folders (above) are skipped at every level and never descended into.',
			)
			.addText(text => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "16";
				text.setValue(normalizePointerDepth(this.plugin.settings.pointerSubfolderDepth).toString())
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed < 1) return;
						this.plugin.settings.pointerSubfolderDepth = normalizePointerDepth(parsed);
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h2', { text: 'Flowcharts' });

		new Setting(containerEl)
			.setName('Include generated code files')
			.setDesc('Include generated binding files (e.g. *.g.cs) when generating flowcharts. Off by default — these are typically large auto-generated files not worth diagramming.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeGeneratedCodeFiles)
				.onChange(async (value) => {
					this.plugin.settings.includeGeneratedCodeFiles = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Prune stale flowcharts')
			.setDesc('On regeneration, trash pre-existing canvases under Subflowcharts that the run did not rewrite but that still carry a managed granularity tag (symbol/codefile/subfolder) — leftovers from earlier naming schemes. Untagged canvases are never touched, only reported.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pruneStaleFlowcharts)
				.onChange(async (value) => {
					this.plugin.settings.pruneStaleFlowcharts = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Prune to system trash')
			.setDesc('Move pruned stale flowchart canvases to the operating system trash instead of the vault trash (.trash folder). Only applies when "Prune stale flowcharts" is on.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pruneToSystemTrash)
				.onChange(async (value) => {
					this.plugin.settings.pruneToSystemTrash = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Node spacing X')
			.setDesc('Horizontal gap (px) between generated flowchart nodes.')
			.addText(text => text
				.setValue(this.plugin.settings.flowchartNodeSpacingX.toString())
				.onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					this.plugin.settings.flowchartNodeSpacingX = parsed;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Node spacing Y')
			.setDesc('Vertical gap (px) between generated flowchart nodes.')
			.addText(text => text
				.setValue(this.plugin.settings.flowchartNodeSpacingY.toString())
				.onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					this.plugin.settings.flowchartNodeSpacingY = parsed;
					await this.plugin.saveSettings();
				}));


	}
}
