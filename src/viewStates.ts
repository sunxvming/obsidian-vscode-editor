
import { Plugin } from "obsidian";
import * as monaco from 'monaco-editor'

/*
Remembers where you left off in each code file. Monaco's view state holds the
cursor, the selection, the scroll offset and which regions are folded, so
restoring it puts the editor back exactly as it was.
*/
export class ViewStates {

	private states: Record<string, monaco.editor.ICodeEditorViewState> = {};

	constructor(private plugin: Plugin) { }

	private get path() {
		return `${this.plugin.manifest.dir}/view-states.json`;
	}

	async load() {
		try {
			const { adapter } = this.plugin.app.vault;
			if (await adapter.exists(this.path)) {
				this.states = JSON.parse(await adapter.read(this.path));
			}
		} catch (e) {
			console.error("VSCode Editor plugin can't read saved view states: " + e);
		}
	}

	get(path: string) {
		return this.states[path];
	}

	set(path: string, state: monaco.editor.ICodeEditorViewState | null) {
		if (state) {
			this.states[path] = state;
		}
	}

	rename(path: string, oldPath: string) {
		this.states[path] = this.states[oldPath];
		delete this.states[oldPath];
	}

	writeAllStatesToDisk() {
		this.plugin.app.vault.adapter.write(this.path, JSON.stringify(this.states));
	}
}
