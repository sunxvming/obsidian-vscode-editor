
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
}

export const DEFAULT_SETTINGS: EditorSettings = {
	extensions: ["ts", "js", "py", "css", "c", "cpp", "go", "rs", "java", "lua", "php", "cs"],
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
}


export const viewType = "vscode-editor";
