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

		containerEl.createEl('h2', { text: 'Code Editor Settings' });


		new Setting(containerEl)
			.setName("基础颜色")
			.setDesc('为代码编辑器选择一个基础颜色，基础颜色默认跟随obsidian的基础颜色。')
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
			.setName('字体大小')
			.setDesc('字体大小desc')
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
			.setName('File Extensions')
			.setDesc('Files with these extensions will show up in the sidebar, and will ' +
				'be available to create new files from. Seperated by commas. ' +
				'Changes to the file extensions need a restart to take effect.')
			.addText(text => text
				.setPlaceholder('js,ts')
				.setValue(this.plugin.settings.extensions.join(","))
				.onChange(async (value) => {
					this.plugin.settings.extensions = value.split(",");
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Folding')
			.setDesc('Editor will support code block folding.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.folding)
				.onChange(async (value) => {
					this.plugin.settings.folding = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Line Numbers')
			.setDesc('Editor will show line numbers.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.lineNumbers)
				.onChange(async (value) => {
					this.plugin.settings.lineNumbers = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Minimap')
			.setDesc('Editor will show a minimap.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.minimap)
				.onChange(async (value) => {
					this.plugin.settings.minimap = value;
					await this.plugin.saveSettings();
				}));

	}
}
