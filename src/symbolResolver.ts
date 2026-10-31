import { App } from "obsidian";
import { Parser, Language, Node as SyntaxNode, Tree } from "web-tree-sitter";

/** Frees a parse tree's wasm memory; a corrupted heap can make delete() throw. */
function deleteTree(tree: Tree | null): void {
	if (!tree) return;
	try {
		tree.delete();
	} catch (e) {
		console.error("vscode-editor: tree-sitter tree cleanup failed", e);
	}
}

export interface CodeSubpath {
	linkpath: string;
	symbol: string | null;
	occurrence: number; // 1-based
}

export interface SymbolRange {
	startLine: number; // 1-based
	endLine: number;   // 1-based, inclusive
	text: string;
}

export type SymbolKind = "function" | "variable" | "enum" | "struct" | "class" | "interface";

export const ALL_SYMBOL_KINDS: SymbolKind[] = ["function", "variable", "enum", "struct", "class", "interface"];

export interface SymbolInfo {
	name: string;
	kind: SymbolKind;
	startLine: number; // 1-based
	endLine: number;   // 1-based, inclusive
	occurrence: number; // 1-based index among same-name symbols (any enabled kind) in document order
	/**
	 * Dotted chain of enclosing named scopes, outermost-first (`MapConfig` for
	 * `fn seed` inside `impl Seed for MapConfig`, `Player` for a C# class
	 * method, `outer` for a nested function). Null for top-level symbols. Used
	 * by flowchart canvas naming to disambiguate same-name symbols.
	 */
	container: string | null;
	/**
	 * Sanitized display types of the parameters, in order (functions only —
	 * empty for other kinds). References/generics are flattened by
	 * `displayType` (`&ReducerContext` → `ReducerContext`, `Vec<MultiShot>` →
	 * `Vec-MultiShot`) so the values are safe in file names.
	 */
	paramTypes: string[];
}

interface SymbolTypeSpec {
	type: string;
	kind: SymbolKind;
}

const LANGUAGE_BY_EXTENSION: Record<string, { wasm: string; symbolTypes: SymbolTypeSpec[] }> = {
	cs: {
		wasm: "tree-sitter-c_sharp.wasm",
		symbolTypes: [
			{ type: "method_declaration", kind: "function" },
			{ type: "constructor_declaration", kind: "function" },
			{ type: "local_function_statement", kind: "function" },
			// field_declaration covers const/static/class fields; locals are
			// local_declaration_statement and stay unlisted on purpose.
			{ type: "field_declaration", kind: "variable" },
			{ type: "enum_declaration", kind: "enum" },
			{ type: "struct_declaration", kind: "struct" },
			{ type: "class_declaration", kind: "class" },
			{ type: "interface_declaration", kind: "interface" },
		],
	},
	rs: {
		wasm: "tree-sitter-rust.wasm",
		symbolTypes: [
			{ type: "function_item", kind: "function" },
			{ type: "static_item", kind: "variable" },
			{ type: "const_item", kind: "variable" },
			{ type: "enum_item", kind: "enum" },
			{ type: "struct_item", kind: "struct" },
			{ type: "trait_item", kind: "interface" },
		],
	},
};

const ATTRIBUTE_TYPES = new Set(["attribute_list", "attribute_item"]);

/**
 * Node types that act as a named container for canvas-naming purposes: any
 * symbol nested inside one gets the container's name in its scope chain.
 * `impl_item` is special-cased (its label is the impl *target* type, not a
 * name field). Anonymous scopes (blocks, closures) never appear here.
 */
const CONTAINER_NAME_TYPES = new Set([
	// rust
	"mod_item", "trait_item", "function_item", "static_item", "const_item",
	// c-sharp
	"namespace_declaration", "class_declaration", "struct_declaration", "interface_declaration",
	"enum_declaration", "record_declaration", "method_declaration", "constructor_declaration",
	"local_function_statement", "property_declaration",
]);

/** C# parameter modifier keywords (anonymous token children of `parameter`). */
const PARAM_MODIFIER_TOKENS = new Set(["ref", "out", "in", "params", "this"]);

export function isSymbolCapableExtension(extension: string): boolean {
	return extension in LANGUAGE_BY_EXTENSION;
}

/**
 * Splits "LocalPlayer.cs#RegisterComponent#2" into its parts.
 * The occurrence suffix is 1-based and defaults to 1.
 */
export function parseCodeSubpath(linktext: string): CodeSubpath {
	const parts = linktext.split("#");
	const linkpath = parts[0];
	let symbol: string | null = null;
	let occurrence = 1;
	if (parts.length > 1 && parts[1].length > 0) {
		symbol = parts[1];
	}
	if (parts.length > 2) {
		const n = parseInt(parts[2], 10);
		if (!isNaN(n) && n > 0) occurrence = n;
	}
	return { linkpath, symbol, occurrence };
}

export class SymbolResolver {
	private app: App;
	private pluginDir: string;
	private parserReady: Promise<boolean> | null = null;
	private languages = new Map<string, Promise<Language | null>>();
	/**
	 * One long-lived parser per symbol-capable extension. Each `new Parser()`
	 * allocates wasm-side memory that only `parser.delete()` frees, so the old
	 * create-per-file pattern leaked a parser per parsed file — scanning a
	 * large vault (every `.rs`/`.cs` file) eventually corrupted the wasm heap
	 * ("RuntimeError: memory access out of bounds" thrown from `parser.delete`
	 * after ~4.7k parses). Trees are deleted right after their data is
	 * extracted, so a shared parser stays flat over thousands of files.
	 */
	private parsers = new Map<string, Parser>();

	constructor(app: App, pluginDir: string) {
		this.app = app;
		this.pluginDir = pluginDir;
	}

	private async readWasm(filename: string): Promise<ArrayBuffer> {
		return await this.app.vault.adapter.readBinary(`${this.pluginDir}/${filename}`);
	}

	private initParser(): Promise<boolean> {
		if (!this.parserReady) {
			this.parserReady = (async () => {
				try {
					// Pass the wasm bytes directly: in Obsidian's Electron renderer the
					// Emscripten glue detects a browser env and would otherwise try to
					// fetch() the file path, which fails. locateFile is still required —
					// without it the glue eagerly builds a URL from import.meta.url,
					// which doesn't exist in the CJS bundle.
					await Parser.init({
						locateFile: () => "web-tree-sitter.wasm",
						wasmBinary: await this.readWasm("web-tree-sitter.wasm"),
					} as any);
					return true;
				} catch (e: any) {
					console.error("vscode-editor: tree-sitter init failed", e);
					return false;
				}
			})();
		}
		return this.parserReady;
	}

	private loadLanguage(extension: string): Promise<Language | null> {
		let cached = this.languages.get(extension);
		if (!cached) {
			cached = (async () => {
				if (!(await this.initParser())) return null;
				try {
					const bytes = new Uint8Array(await this.readWasm(LANGUAGE_BY_EXTENSION[extension].wasm));
					return await Language.load(bytes);
				} catch (e) {
					console.error(`vscode-editor: failed to load tree-sitter grammar for .${extension}`, e);
					return null;
				}
			})();
			this.languages.set(extension, cached);
		}
		return cached;
	}

	/**
	 * Finds the `occurrence`-th (1-based) symbol named `name` in the file content,
	 * in document order. Overloads / same-name symbols (of any enabled kind) are
	 * distinguished by the occurrence index.
	 */
	async findSymbol(
		content: string,
		extension: string,
		name: string,
		occurrence: number,
		kinds: SymbolKind[] = ALL_SYMBOL_KINDS,
	): Promise<SymbolRange | null> {
		const langSpec = LANGUAGE_BY_EXTENSION[extension];
		if (!langSpec) return null;
		const parser = await this.parserFor(extension);
		if (!parser) return null;

		let tree: Tree | null = null;
		try {
			tree = parser.parse(content);
			if (!tree) return null;
			const matches: SyntaxNode[] = [];
			this.collectSymbolNodes(tree.rootNode, this.typeMapFor(langSpec, kinds), name, matches);
			const node = matches[occurrence - 1];
			if (!node) return null;

			// Extend the range upwards over contiguous attribute lines ([HttpGet], #[test], ...)
			let startRow = node.startPosition.row;
			let sibling = node.previousNamedSibling;
			while (sibling && ATTRIBUTE_TYPES.has(sibling.type) && sibling.endPosition.row <= startRow) {
				startRow = sibling.startPosition.row;
				sibling = sibling.previousNamedSibling;
			}
			const endRow = node.endPosition.row;

			const lines = content.split("\n");
			return {
				startLine: startRow + 1,
				endLine: endRow + 1,
				text: lines.slice(startRow, endRow + 1).join("\n"),
			};
		} catch (e) {
			console.error("vscode-editor: tree-sitter parse failed", e);
			return null;
		} finally {
			deleteTree(tree);
		}
	}

	/**
	 * Lists every symbol of the enabled kinds in the file in document order,
	 * with a 1-based occurrence index distinguishing same-name symbols.
	 */
	async listSymbols(
		content: string,
		extension: string,
		kinds: SymbolKind[] = ALL_SYMBOL_KINDS,
	): Promise<SymbolInfo[]> {
		const langSpec = LANGUAGE_BY_EXTENSION[extension];
		if (!langSpec) return [];
		const parser = await this.parserFor(extension);
		if (!parser) return [];

		let tree: Tree | null = null;
		try {
			tree = parser.parse(content);
			if (!tree) return [];
			const typeMap = this.typeMapFor(langSpec, kinds);
			const nodes: SyntaxNode[] = [];
			this.collectSymbolNodes(tree.rootNode, typeMap, null, nodes);

			const seen = new Map<string, number>();
			const out: SymbolInfo[] = [];
			for (const node of nodes) {
				const nameNode = extractSymbolName(node);
				if (!nameNode) continue;
				const name = nameNode.text;
				const occurrence = (seen.get(name) ?? 0) + 1;
				seen.set(name, occurrence);
				const kind = typeMap.get(node.type)!;
				const container = extractContainer(node);
				out.push({
					name,
					kind,
					startLine: node.startPosition.row + 1,
					endLine: node.endPosition.row + 1,
					occurrence,
					container,
					paramTypes: kind === "function" ? extractParamTypes(node) : [],
				});
			}
			return out;
		} catch (e) {
			console.error("vscode-editor: tree-sitter parse failed", e);
			return [];
		} finally {
			deleteTree(tree);
		}
	}

	/** Drops every cached parser (plugin unload); they are recreated lazily. */
	dispose(): void {
		for (const parser of this.parsers.values()) {
			try {
				parser.delete();
			} catch (e) {
				// A corrupted wasm heap can make delete() itself throw — nothing to do.
				console.error("vscode-editor: tree-sitter parser cleanup failed", e);
			}
		}
		this.parsers.clear();
	}

	/** The shared parser for `extension`, reusing the same wasm allocation every call. */
	private async parserFor(extension: string): Promise<Parser | null> {
		const existing = this.parsers.get(extension);
		if (existing) return existing;
		const language = await this.loadLanguage(extension);
		if (!language) return null;
		const raced = this.parsers.get(extension);
		if (raced) return raced;
		const parser = new Parser();
		parser.setLanguage(language);
		this.parsers.set(extension, parser);
		return parser;
	}

	private typeMapFor(langSpec: { symbolTypes: SymbolTypeSpec[] }, kinds: SymbolKind[]): Map<string, SymbolKind> {
		const enabled = new Set(kinds);
		const map = new Map<string, SymbolKind>();
		for (const spec of langSpec.symbolTypes) {
			if (enabled.has(spec.kind)) map.set(spec.type, spec.kind);
		}
		return map;
	}

	private collectSymbolNodes(node: SyntaxNode, typeMap: Map<string, SymbolKind>, name: string | null, out: SyntaxNode[]): void {
		if (typeMap.has(node.type)) {
			const nameNode = extractSymbolName(node);
			if (nameNode && (name === null || nameNode.text === name)) {
				out.push(node);
			}
		}
		for (const child of node.namedChildren) {
			this.collectSymbolNodes(child, typeMap, name, out);
		}
	}
}

/**
 * The symbol's display name. Everything except C# field declarations carries a
 * `name` field; a field declaration's name lives one level down on its first
 * `variable_declarator` (a multi-declarator field like `int a, b;` exposes only
 * the first name). Falls back to the last direct `identifier` child, matching
 * the historical constructor handling.
 */
function extractSymbolName(node: SyntaxNode): SyntaxNode | null {
	const named = node.childForFieldName("name");
	if (named) return named;
	if (node.type === "field_declaration") {
		const declarator = firstDescendantOfType(node, "variable_declarator");
		if (declarator) {
			return declarator.childForFieldName("name") ?? firstDescendantOfType(declarator, "identifier");
		}
		return null;
	}
	let result: SyntaxNode | null = null;
	for (const child of node.namedChildren) {
		if (child.type === "identifier") result = child;
	}
	return result;
}

function firstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
	for (const child of node.namedChildren) {
		if (child.type === type) return child;
		const found = firstDescendantOfType(child, type);
		if (found) return found;
	}
	return null;
}

/**
 * The symbol's enclosing named scopes, outermost-first, joined with "." —
 * e.g. `MapConfig` for `fn seed` in `impl Seed for MapConfig`, `Player.Shoot`
 * for a local function inside method `Shoot`. `impl_item` contributes its
 * target type (sanitized), not a name. Returns null for top-level symbols.
 */
function extractContainer(node: SyntaxNode): string | null {
	const parts: string[] = [];
	let cur = node.parent;
	while (cur) {
		if (cur.type === "impl_item") {
			const target = cur.childForFieldName("type");
			if (target) parts.unshift(displayType(target.text));
		} else if (CONTAINER_NAME_TYPES.has(cur.type)) {
			const name = cur.childForFieldName("name");
			if (name) parts.unshift(name.text);
		}
		cur = cur.parent;
	}
	return parts.length > 0 ? parts.join(".") : null;
}

/** The nearest enclosing `impl_item`'s target type, for resolving `Self`. */
function extractSelfType(node: SyntaxNode): string | null {
	let cur = node.parent;
	while (cur) {
		if (cur.type === "impl_item") {
			const target = cur.childForFieldName("type");
			if (target) return displayType(target.text);
		}
		cur = cur.parent;
	}
	return null;
}

/**
 * Sanitized display types of a function's parameters, in order. `self`
 * parameters collapse to the literal `self` (they're constant per impl, so a
 * minimal-distinguishing set never picks them). C# modifiers are prepended
 * (`out int`). `Self` resolves to the enclosing impl target.
 */
function extractParamTypes(node: SyntaxNode): string[] {
	const params = node.childForFieldName("parameters");
	if (!params) return [];
	const selfType = extractSelfType(node);
	const out: string[] = [];
	for (const child of params.namedChildren) {
		if (child.type === "self_parameter") {
			out.push("self");
			continue;
		}
		if (child.type !== "parameter" && child.type !== "parameter_array") continue;
		const typeNode = child.childForFieldName("type");
		if (!typeNode) continue;
		let mods = "";
		for (const c of child.children) {
			if (PARAM_MODIFIER_TOKENS.has(c.type)) mods += `${c.type} `;
		}
		out.push(displayType(`${mods}${typeNode.text}`, selfType));
	}
	return out;
}

/**
 * Flattens a raw type string into a filename-safe display form (Obsidian
 * forbids `# ^ [ ] |` plus the Windows set `< > : * ? " \ /`). References and
 * lifetimes vanish (`&'a str` → `str`), generics dash-join
 * (`Vec<MultiShot>` → `Vec-MultiShot`), `Self` resolves to the impl target.
 * Capped at 40 chars so canvas names stay well under path limits.
 */
export function displayType(raw: string, selfType: string | null = null): string {
	let t = raw.trim().replace(/\s+/g, " ");
	t = t.replace(/'\w+/g, ""); // lifetimes
	t = t.replace(/&/g, ""); // references
	t = t.replace(/\[\]/g, "-Array"); // C# arrays: int[] → int-Array
	t = t.replace(/[\[\]]/g, ""); // rust arrays/slices: [u8; 32] → u8; 32
	t = t.replace(/\?/g, ""); // nullable: string? → string
	t = t.replace(/::/g, "-"); // crate::Foo → crate-Foo
	t = t.replace(/</g, "-").replace(/>/g, ""); // Vec<MultiShot> → Vec-MultiShot
	t = t.replace(/[()]/g, ""); // tuples: (u8, u8) → u8, u8
	t = t.replace(/,\s*/g, "-");
	t = t.replace(/;\s*/g, "-"); // [u8; 32] → u8-32
	t = t.replace(/[*"\\/:|#^]/g, ""); // any remaining illegal chars
	t = t.replace(/ ?- ?/g, "-").replace(/-{2,}/g, "-");
	t = t.trim().replace(/^-+|-+$/g, "").replace(/[. ]+$/g, ""); // no trailing dot/space (Windows)
	if (t === "Self" && selfType) t = selfType;
	if (t.length > 40) t = `${t.slice(0, 39)}…`;
	return t || "unknown";
}
