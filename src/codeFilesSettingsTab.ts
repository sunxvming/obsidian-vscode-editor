import { App, PluginSettingTab, Setting } from "obsidian";
import CodeFilesPlugin from "./main";
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




	}
}
