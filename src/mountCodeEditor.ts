
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
	}

	getValue() {
		return this.monacoEditor.getValue();
	}


}
