import {Plugin} from "obsidian";
import {DEFAULT_SETTINGS, MyPluginSettings} from "./common";
import {CodeEditorView} from "./codeEditorView";
import {CreateCodeFileModal} from "./createCodeFileModal";
import {CodeFilesSettingsTab} from "./codeFilesSettingsTab";
import {viewType} from "./common";
export default class CodeFilesPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(viewType, leaf => new CodeEditorView(leaf, this));
		this.registerExtensions(this.settings.extensions, viewType);

        
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item
						.setTitle("Create Code File")
						.setIcon("file-json")
						.onClick(async () => {
							new CreateCodeFileModal(this, file).open();
						});
				});
			})
		);

		this.addRibbonIcon('file-json', 'Create Code File', () => {
			new CreateCodeFileModal(this).open();
		});

		this.addCommand({
			id: 'create',
			name: 'Create new Code File',
			callback: () => {
				new CreateCodeFileModal(this).open();
			}
		});

		this.addSettingTab(new CodeFilesSettingsTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
