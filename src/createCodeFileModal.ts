import {
	ButtonComponent,
	DropdownComponent,
	Modal,
	normalizePath,
	Notice,
	TAbstractFile,
	TextComponent,
	TFile,
	TFolder
} from "obsidian";
import CodeFilesPlugin from "./main";

export class CreateCodeFileModal extends Modal {
	fileName = "My code file";
	fileExtension = this.plugin.settings.extensions[0];
	parent: TAbstractFile;

	constructor(private plugin: CodeFilesPlugin, parent?: TAbstractFile) {
		super(plugin.app);
		this.parent = parent ?? this.plugin.app.vault.getRoot();
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.addClass("create-code-file-modal");
		const fileNameInput = new TextComponent(contentEl);
		fileNameInput.inputEl.addClass("modal_input");
		fileNameInput.setValue(this.fileName);
		fileNameInput.inputEl.addEventListener("keypress", e => {
			if (e.key === "Enter") {
				this.complete();
			}
		});
		fileNameInput.onChange(value => this.fileName = value);

		const fileExtensionInput = new DropdownComponent(contentEl);
		fileExtensionInput.selectEl.addClass("modal_select");
		fileExtensionInput.addOptions(this.plugin.settings.extensions.reduce((acc, ext) => {
			acc[ext] = ext;
			return acc;
		}, {} as any));
		fileExtensionInput.setValue(this.fileExtension);
		fileExtensionInput.onChange(value => this.fileExtension = value);

		fileExtensionInput.selectEl.addEventListener("keypress", e => {
			if (e.key === "Enter") {
				this.complete();
			}
		});

		const submitButton = new ButtonComponent(contentEl);
		submitButton.setCta();
		submitButton.setButtonText("Create");
		submitButton.onClick(() => this.complete());

		fileNameInput.inputEl.focus();
	}

	async complete() {
		this.close();
		const parent = (this.parent instanceof TFile ? this.parent.parent : this.parent) as TFolder;
		const newPath = `${parent.path}/${this.fileName}.${this.fileExtension}`;
		const existingFile = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
		if (existingFile && existingFile instanceof TFile) {
			new Notice("File already exists");
			const leaf = this.app.workspace.getLeaf(true);
			leaf.openFile(existingFile as any);
			return;
		}

		const newFile = await this.app.vault.create(
			newPath,
			"",
			{}
		);
		const leaf = this.app.workspace.getLeaf(true);
		leaf.openFile(newFile);
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
