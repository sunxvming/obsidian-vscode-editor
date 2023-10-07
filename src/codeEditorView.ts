// https://github.com/microsoft/monaco-editor/issues/1288

import { TextFileView, TFile, WorkspaceLeaf } from "obsidian";
import { viewType } from "./common";
import CodeFilesPlugin from "./main";
import * as monaco from 'monaco-editor'
import { isObsidianThemeDark, getLanguage } from "./ObsidianUtils";


export class CodeEditorView extends TextFileView {

	value = "";
	monacoEditor: monaco.editor.IStandaloneCodeEditor;


	constructor(leaf: WorkspaceLeaf, private plugin: CodeFilesPlugin) {
		super(leaf);
	}

	/*
	execute order: onOpen -> onLoadFile -> setViewData -> onUnloadFile -> onClose
	*/
	async onOpen() {
		await super.onOpen();
	}

	async onLoadFile(file: TFile) {

		const minmap: monaco.editor.IEditorMinimapOptions = {
			enabled: this.plugin.settings.minimap,
		}

		this.monacoEditor = monaco.editor.create(this.contentEl, {
			automaticLayout: true,
			language: getLanguage(this.file?.extension ?? ""),
			theme: this.getThemeColor(),
			lineNumbers: this.plugin.settings.lineNumbers ? "on" : "off",
			minimap: minmap,
			folding: this.plugin.settings.folding,
			fontSize: this.plugin.settings.fontSize,
			scrollBeyondLastLine: false,
		});

		this.monacoEditor.onDidChangeModelContent(() => {
			this.requestSave();
		});

		this.addCtrlKeyWheelEvents();

		// const model = this.monacoEditor.getModel();
		// monaco.editor.setModelLanguage(model, this.getLanguage());
		await super.onLoadFile(file);
	}

	async onUnloadFile(file: TFile) {
		await super.onUnloadFile(file);
		this.monacoEditor.dispose();
	}

	async onClose() {
		await super.onClose();
	}

	onResize() {
		this.monacoEditor.layout();
	}

	getViewType(): string {
		return viewType;
	}

	getContext(file?: TFile) {
		return file?.path ?? this.file?.path;
	}



	getViewData = () => {
		return this.monacoEditor.getValue();
	}

	setViewData = (data: string, clear: boolean) => {
		if (clear) {
			this.monacoEditor.getModel()?.setValue(data);
		} else {
			this.monacoEditor.setValue(data);
		}
	}
	clear = () => {
		this.monacoEditor.setValue('');
	}


	getThemeColor(): string {
		const themeColor = this.plugin.settings.themeColor;
		let theme: string = "vs";
		if (themeColor === "AUTO") {
			theme = isObsidianThemeDark() === true ? "vs-dark" : "vs";
		} else if (themeColor === "DARK") {
			theme = "vs-dark";
		} else if (themeColor === "LIGHT") {
			theme = "vs";
		}
		return theme;
	}


	private addCtrlKeyWheelEvents = () => {
		this.containerEl.addEventListener('wheel', this.mousewheelHandle,  true);

	}

	private mousewheelHandle = (event: WheelEvent) => {
		if(event.ctrlKey){
			let delta = 0 < event.deltaY ? 1 : -1;
			this.plugin.settings.fontSize += delta;
			this.plugin.saveSettings();
			this.monacoEditor.updateOptions({
				fontSize: this.plugin.settings.fontSize,
			})
			
			event.stopPropagation();
		}
	}




}
