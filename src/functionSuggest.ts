import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
	prepareFuzzySearch,
} from "obsidian";
import CodeFilesPlugin from "./main";
import { isSymbolCapableExtension, SymbolInfo } from "./symbolResolver";

/**
 * Pops up a symbol list (functions, variables, enums, … per the linkable-symbol
 * settings) when typing `#` inside a wikilink/embed that points
 * at a symbol-capable code file (`[[LocalPlayer.cs#…`), mirroring Obsidian's
 * native `#heading` suggestions for markdown files.
 *
 * Registered in main.ts and moved to the front of the internal
 * editorSuggest.suggests array so it wins over core's heading suggest;
 * onTrigger returns null for anything that isn't a code file, so native
 * behaviour is untouched elsewhere.
 */
export class CodeFunctionSuggest extends EditorSuggest<SymbolInfo> {
	private plugin: CodeFilesPlugin;
	// Cache parsed symbols per file path+mtime+kinds so each keystroke doesn't re-parse.
	private cache = new Map<string, { mtime: number; kindsKey: string; symbols: SymbolInfo[] }>();

	constructor(plugin: CodeFilesPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!file) return null;
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const match = /(?:!)?\[\[([^\[\]#|]+)#([^\[\]#|]*)$/.exec(before);
		if (!match) return null;

		const target = this.plugin.app.metadataCache.getFirstLinkpathDest(match[1], file.path);
		if (!target) return null;
		if (!isSymbolCapableExtension(target.extension)) return null;
		if (!this.plugin.settings.extensions.includes(target.extension)) return null;

		const query = match[2];
		return {
			start: { line: cursor.line, ch: cursor.ch - query.length },
			end: cursor,
			query,
		};
	}

	async getSuggestions(ctx: EditorSuggestContext): Promise<SymbolInfo[]> {
		const target = this.resolveTarget(ctx);
		if (!target) return [];

		let symbols: SymbolInfo[];
		const kinds = this.plugin.settings.linkableSymbolKinds;
		const kindsKey = kinds.join(",");
		const cached = this.cache.get(target.path);
		if (cached && cached.mtime === target.stat.mtime && cached.kindsKey === kindsKey) {
			symbols = cached.symbols;
		} else {
			const content = await this.plugin.app.vault.cachedRead(target);
			symbols = await this.plugin.symbolResolver.listSymbols(content, target.extension, kinds);
			this.cache.set(target.path, { mtime: target.stat.mtime, kindsKey, symbols });
		}

		if (!ctx.query) return symbols;
		const fuzzy = prepareFuzzySearch(ctx.query);
		return symbols.filter((s) => fuzzy(s.name));
	}

	renderSuggestion(item: SymbolInfo, el: HTMLElement): void {
		el.createSpan({ text: item.name });
		el.createSpan({
			cls: "vscode-editor-function-suggest-line",
			text: `${item.kind !== "function" ? `${item.kind} ` : ""}:${item.startLine}${item.occurrence > 1 ? ` #${item.occurrence}` : ""}`,
		});
	}

	selectSuggestion(item: SymbolInfo): void {
		const ctx = this.context;
		if (!ctx) return;
		const text = item.occurrence > 1 ? `${item.name}#${item.occurrence}` : item.name;
		ctx.editor.replaceRange(text, ctx.start, ctx.end);
		this.close();
	}

	private resolveTarget(ctx: EditorSuggestContext): TFile | null {
		const before = ctx.editor.getLine(ctx.start.line).slice(0, ctx.start.ch);
		const match = /(?:!)?\[\[([^\[\]#|]+)#$/.exec(before);
		if (!match) return null;
		return this.plugin.app.metadataCache.getFirstLinkpathDest(match[1], ctx.file.path);
	}
}
