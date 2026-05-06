
import CodeFilesPlugin from "./main";
import * as monaco from 'monaco-editor'
import { genEditorSettings } from "./ObsidianUtils";


export class mountCodeEditor {
	contentEl: HTMLElement;
	value = "";
	monacoEditor: monaco.editor.IStandaloneCodeEditor;
	plugin: CodeFilesPlugin;

	constructor(contentEl: HTMLElement, plugin: CodeFilesPlugin, code: string, language: string, miniMap: boolean = true, wordWrap: boolean = false) {
		this.contentEl = contentEl;
		this.plugin = plugin;
		this.value = code;

		let setting = genEditorSettings(this.plugin.settings, language, miniMap, wordWrap);
		this.monacoEditor = monaco.editor.create(this.contentEl, setting);
		this.monacoEditor.setValue(this.value);

		window.addEventListener('keydown', this.keyHandle, true);
	}

	getValue() {
		return this.monacoEditor.getValue();
	}

	dispose() {
		window.removeEventListener('keydown', this.keyHandle, true);
		this.monacoEditor.dispose();
	}

	// Obsidian's global keydown handler (useCapture=true) blocks child elements from receiving
	// Ctrl/Cmd shortcuts, so we intercept them here and trigger Monaco actions directly.
	private keyHandle = (event: KeyboardEvent) => {
		if (!this.monacoEditor.hasTextFocus())
			return;

		const isMod = event.ctrlKey || event.metaKey;

		const ctrlMap = new Map<string, string>([
			['f', 'actions.find'],
			['h', 'editor.action.startFindReplaceAction'],
			['/', 'editor.action.commentLine'],
			['Enter', 'editor.action.insertLineAfter'],
			['[', 'editor.action.outdentLines'],
			[']', 'editor.action.indentLines'],
			['d', 'editor.action.copyLinesDownAction'],
			['v', 'paste'],
			['c', 'copy'],
			['x', 'cut'],
			['a', 'editor.action.selectAll'],
		]);
		if (isMod) {
			const triggerName = ctrlMap.get(event.key);
			if (triggerName) {
				event.preventDefault();
				event.stopPropagation();
				if (triggerName === 'paste') {
					navigator.clipboard.readText().then((clipboard) => {
						this.monacoEditor.trigger('source', triggerName, {text: clipboard });
					})
				}
				else if (triggerName === 'copy') {
					const selection = this.monacoEditor.getSelection();
					const model = this.monacoEditor.getModel();
					if (selection && model) {
						const text = model.getValueInRange(selection);
						navigator.clipboard.writeText(text);
					}
				}
				else if (triggerName === 'cut') {
					const selection = this.monacoEditor.getSelection();
					const model = this.monacoEditor.getModel();
					if (selection && model) {
						const text = model.getValueInRange(selection);
						navigator.clipboard.writeText(text);
						this.monacoEditor.executeEdits('cut', [{
							range: selection,
							text: '',
							forceMoveMarkers: true
						}]);
					}
				}
				else {
					this.monacoEditor.trigger('source', triggerName, null);
				}
			}
		}


		if (event.altKey) {
			if (event.key === 'z') {
				this.plugin.settings.wordWrap = !this.plugin.settings.wordWrap;
				this.plugin.saveSettings();
				this.monacoEditor.updateOptions({
					wordWrap: this.plugin.settings.wordWrap ? "on" : "off",
				})

			}
		}

	}

}
