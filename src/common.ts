
import { ALL_SYMBOL_KINDS, SymbolKind } from "./symbolResolver";

export interface EditorSettings {
	extensions: string[];
	folding: boolean;
	lineNumbers: boolean;
	wordWrap: boolean;
	minimap: boolean;
	semanticValidation: boolean;
	syntaxValidation: boolean;
	themeColor: string;
	fontSize: number;
	fontFamily: string;
	fontLigatures: boolean;
	showEmbedHeader: boolean;
	canvasNodeWidth: number;
	canvasNodeHeight: number;
	flowchartNodeSpacingX: number;
	flowchartNodeSpacingY: number;
	linkableSymbolKinds: SymbolKind[];
	/** Whether flowchart generation includes generated binding files (e.g. `*.g.cs`). */
	includeGeneratedCodeFiles: boolean;
	/** Whether stale generated canvases (managed granularity tag, not rewritten by the run) are trashed on regeneration. */
	pruneStaleFlowcharts: boolean;
	/** Whether pruning uses the system trash instead of the vault trash. */
	pruneToSystemTrash: boolean;
	/**
	 * Folders skipped by every code scan (flowchart generation and pointer
	 * files) — vault-relative paths or bare names, `*` wildcards allowed.
	 * See folderIgnore.ts for the matching rules.
	 */
	ignoredFolders: string[];
	/**
	 * How many levels of subfolders "Generate pointers in subfolders" writes a
	 * `pointers.md` into: 1 = the command folder's immediate subfolders only
	 * (default), 2 = those plus their subfolders, and so on. Ignored folders
	 * (see `ignoredFolders`) are skipped at every level and never descended
	 * into. 0 is treated as 1.
	 */
	pointerSubfolderDepth: number;
	/**
	 * File name of the generated usage indexes; `{folder}` is replaced by the
	 * folder's name (generic names like `src`/`tests` get their parent's name
	 * in front: `region-src`). Default `{folder}.usages.md`. Indexes written
	 * under an old name are trashed on the next run.
	 */
	pointerFileName: string;
	/**
	 * Code sides — which deployable each vault code file belongs to, one side
	 * per line: `server: server/` / `client: client/, tools/kg_bot/`. Files on
	 * no side are shared code. Drives the "shared between …" notes in pointer
	 * files and the shared-code links of flows (see flowchartSides.ts). Empty =
	 * each file's first path segment is its side.
	 */
	codeSides: string;
}

export const DEFAULT_SETTINGS: EditorSettings = {
	extensions: ["ts", "js", "py", "css", "c", "cpp", "go", "rs", "java", "lua", "php", "cs", "tscn"],
	folding: true,
	lineNumbers: true,
	wordWrap: true,
	minimap: true,
	semanticValidation: true,
	syntaxValidation: true,
	themeColor: "AUTO",
	fontSize: 14,
	fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
	fontLigatures: true,
	showEmbedHeader: true,
	canvasNodeWidth: 560,
	canvasNodeHeight: 400,
	flowchartNodeSpacingX: 60,
	flowchartNodeSpacingY: 100,
	linkableSymbolKinds: [...ALL_SYMBOL_KINDS],
	includeGeneratedCodeFiles: false,
	pruneStaleFlowcharts: true,
	pruneToSystemTrash: false,
	ignoredFolders: [],
	pointerSubfolderDepth: 1,
	pointerFileName: "{folder}.usages.md",
	codeSides: "",
}


export const viewType = "vscode-editor";
