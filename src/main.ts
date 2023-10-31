import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, EditorSettings } from "./common";
import { CodeEditorView } from "./codeEditorView";
import { CreateCodeFileModal } from "./createCodeFileModal";
import { CodeFilesSettingsTab } from "./codeFilesSettingsTab";
import { viewType } from "./common";
import { t } from 'src/lang/helpers';

export default class CodeFilesPlugin extends Plugin {
	settings: EditorSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(viewType, leaf => new CodeEditorView(leaf, this));
		this.registerExtensions(this.settings.extensions, viewType);


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
