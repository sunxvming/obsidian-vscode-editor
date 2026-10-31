import { Component, TFile } from "obsidian";
import CodeFilesPlugin from "./main";
import { mountCodeEditor } from "./mountCodeEditor";
import { isSymbolCapableExtension, parseCodeSubpath, SymbolRange } from "./symbolResolver";

/**
 * Registers a code-file embed creator for every extension the plugin manages,
 * so ![[file.cs]] / ![[file.rs#someFn]] render as read-only Monaco editors
 * instead of Obsidian's generic file chip.
 *
 * Uses the internal app.embedRegistry (same registry core uses for png/pdf/md
 * embeds); extensions already claimed by core (md, png, ...) are skipped.
 */
export function registerCodeEmbedCreators(plugin: CodeFilesPlugin) {
	const registry = (plugin.app as any).embedRegistry;
	if (!registry) return;

	const registered: string[] = [];
	for (const extension of plugin.settings.extensions) {
		if (registry.isExtensionRegistered(extension)) continue;
		registry.registerExtension(
			extension,
			(ctx: any, file: TFile, subpath: string) => new CodeFileEmbed(plugin, ctx, file, subpath)
		);
		registered.push(extension);
	}
	plugin.register(() => {
		for (const extension of registered) {
			registry.unregisterExtension(extension);
		}
	});
}

class CodeFileEmbed extends Component {
	private plugin: CodeFilesPlugin;
	private ctx: any;
	private file: TFile;
	private subpath: string;
	private containerEl: HTMLElement;
	private editorEl: HTMLElement | null = null;
	private mounted: mountCodeEditor | null = null;
	private classObserver: MutationObserver | null = null;

	constructor(plugin: CodeFilesPlugin, ctx: any, file: TFile, subpath: string) {
		super();
		this.plugin = plugin;
		this.ctx = ctx;
		this.file = file;
		this.subpath = subpath ?? "";
		this.containerEl = ctx.containerEl;
		this.containerEl.addClass("file-embed", "vscode-editor-code-embed");
	}

	async loadFile() {
		const content = await this.plugin.app.vault.cachedRead(this.file);

		const { symbol, occurrence } = parseCodeSubpath(this.subpath);
		let symbolRange: SymbolRange | null = null;
		if (symbol && isSymbolCapableExtension(this.file.extension)) {
			symbolRange = await this.plugin.symbolResolver.findSymbol(
				content, this.file.extension, symbol, occurrence, this.plugin.settings.linkableSymbolKinds
			);
		}

		if (this.plugin.settings.showEmbedHeader) {
			const headerEl = this.containerEl.createDiv({ cls: "vscode-editor-code-embed-header" });
			const titleText = symbol
				? `${this.file.name}#${symbol}${occurrence > 1 ? `#${occurrence}` : ""}`
				: this.file.name;
			const titleEl = headerEl.createEl("a", {
				cls: "vscode-editor-code-embed-title",
				text: titleText,
			});
			titleEl.addEventListener("click", (evt) => {
				evt.preventDefault();
				this.plugin.app.workspace.openLinkText(this.ctx.linktext, this.ctx.sourcePath);
			});
			if (symbol && !symbolRange) {
				headerEl.createSpan({
					cls: "vscode-editor-code-embed-warning",
					text: isSymbolCapableExtension(this.file.extension)
						? ` — symbol "${symbol}" not found, showing whole file`
						: " — symbol links are only supported for .cs and .rs",
				});
			}
		}

		const lines = (symbolRange ? symbolRange.text : content).split("\n");
		const lineHeight = this.plugin.settings.fontSize * 1.5;
		// Only a seed height so Monaco has a sized container to lay out into; the real
		// height is taken from the editor itself in syncHeight() as soon as it exists.
		const seedHeight = lines.length * lineHeight + 10;
		const startLine = symbolRange ? symbolRange.startLine : 1;

		const editorEl = this.containerEl.createDiv({ cls: "vscode-editor-code-embed-editor" });
		this.editorEl = editorEl;
		editorEl.style.height = `${seedHeight}px`;

		this.mounted = new mountCodeEditor(
			editorEl,
			this.plugin,
			symbolRange ? symbolRange.text : content,
			this.file.extension,
			false,
			false,
			{
				readOnly: true,
				scrollBeyondLastLine: false,
				// Pin Monaco's line height so it doesn't vary by platform (left unset, Monaco
				// derives its own ratio from fontSize), keeping the seed height close to the
				// final one and avoiding a visible resize jump on load.
				lineHeight,
				// Only supply a custom renderer when line numbers are wanted — a function here
				// always renders numbers regardless of the "off" the settings-driven default
				// (genEditorSettings) would otherwise produce, so it must not be set unconditionally.
				lineNumbers: this.plugin.settings.lineNumbers
					? (n: number) => String(startLine + n - 1)
					: "off",
				renderLineHighlight: "none",
			}
		);

		this.applyLayout();
		// The canvas hands the embed creator a bare, detached container and only stamps
		// `canvas-node-content` onto it later, so the first applyLayout() above cannot yet
		// tell a canvas node from a note. Watch for the class rather than guessing at the
		// delay — neither a timer nor requestAnimationFrame lands reliably after it (the
		// canvas' rAF loop is parked outright while the Obsidian window is hidden).
		this.classObserver = new MutationObserver(() => this.applyLayout());
		this.classObserver.observe(this.containerEl, {
			attributes: true,
			attributeFilter: ["class"],
		});
		// Word wrap makes the content height depend on the container width, so it changes
		// whenever a canvas node is resized or the note pane narrows.
		this.mounted.monacoEditor.onDidContentSizeChange(() => this.applyLayout());
	}

	/**
	 * Picks how the editor is sized:
	 *
	 * - **Canvas file node** — a fixed-size box whose content element Obsidian keeps at
	 *   `overflow: hidden`. The editor fills the node and Monaco scrolls itself, exactly like
	 *   the full-page code view.
	 * - **Anywhere else** — the note is what scrolls, so the editor has to be exactly as tall
	 *   as Monaco's content. A line count × line height estimate is not good enough: word wrap
	 *   turns one source line into several, and every pixel of the difference is content that
	 *   nothing can scroll to. Take the height from the editor itself instead.
	 */
	private applyLayout() {
		if (!this.mounted || !this.editorEl) return;

		// `canvas-node-content` marks a canvas *file* node specifically — an `![[file.cs]]`
		// written inside a canvas text node is an ordinary embed in a scrolling markdown
		// view, so it wants the grow-to-content path below.
		if (this.containerEl.hasClass("canvas-node-content")) {
			// Settled — the container's classes tell us nothing more from here on.
			this.classObserver?.disconnect();
			this.containerEl.addClass("vscode-editor-code-embed-fill");
			this.editorEl.style.removeProperty("height");
			return;
		}

		const contentHeight = this.mounted.monacoEditor.getContentHeight();
		if (contentHeight <= 0) return;
		const maxHeightOverride = this.getMaxHeightOverride();
		const height = maxHeightOverride
			? Math.min(maxHeightOverride, contentHeight)
			: contentHeight;
		// Guard against a resize feedback loop: a height change can shift the container's
		// width (scrollbar appearing/disappearing), which re-wraps and fires this again.
		if (Math.abs(this.editorEl.clientHeight - height) < 1) return;
		this.editorEl.style.height = `${height}px`;
	}

	/**
	 * Reads a per-embed max-height override from `![[file.cs|500]]`. Obsidian parses the
	 * `|500` alias using the same convention as image sizing (`![[img.png|500]]`) and sets it
	 * as a `width` attribute on the embed container before the creator runs — there's no
	 * dedicated "height" alias syntax to hook into, so we repurpose that attribute here.
	 */
	private getMaxHeightOverride(): number | null {
		const raw = this.containerEl.getAttribute("width");
		if (!raw) return null;
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? value : null;
	}

	onunload() {
		this.classObserver?.disconnect();
		this.classObserver = null;
		if (this.mounted) {
			this.mounted.monacoEditor.dispose();
			this.mounted = null;
		}
		this.editorEl = null;
		this.containerEl.empty();
		super.onunload();
	}
}
