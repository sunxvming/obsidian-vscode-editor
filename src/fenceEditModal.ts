import { Modal, Notice } from "obsidian";
import { mountCodeEditor } from "./mountCodeEditor";
import CodeFilesPlugin from "./main";
import { FenceEditContext } from "./fenceEditContext";

export class FenceEditModal extends Modal {
	private codeEditor: mountCodeEditor;

	private constructor(
		private plugin: CodeFilesPlugin,
		private code: string,
		private language: string,
		private onSave: (changedCode: string) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		super.onOpen();

		this.codeEditor = new mountCodeEditor(
			this.contentEl,
			this.plugin,
			this.code,
			this.language,
		);

		this.modalEl.setCssProps({
			"--dialog-width": "90vw",
			"--dialog-height": "90vh",
		});
		this.modalEl.style.height = "var(--dialog-height)";

		let closeButton = this.modalEl.querySelector<HTMLDivElement>(
			".modal-close-button"
		)
		closeButton!.style.background = "var(--modal-background)";
		closeButton!.style.zIndex = "9999";
	}

	onClose() {
		super.onClose();
		this.onSave(this.codeEditor.getValue());
	}

	static openOnCurrentCode(plugin: CodeFilesPlugin) {
		const context = FenceEditContext.create(plugin);

		if (!context.isInFence()) {
			new Notice("Your cursor is currently not in a valid code block.");
			return;
		}

		const fenceData = context.getFenceData();

		if (!fenceData) {
			return;
		}

		new FenceEditModal(
			plugin,
			fenceData.content,
			fenceData.language,
			(value) => context.replaceFenceContent(value)
		).open();
	}
}
