import { EditorSettings } from "./common";
import * as monaco from 'monaco-editor'


export const isObsidianThemeDark = () => document.body.classList.contains("theme-dark");

export function getThemeColor(themeColor: string): string {
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

export function genEditorSettings(setting: EditorSettings, language: string, minimap: boolean = true, wordwrap: boolean = false) {
    let minimapFlag = setting.minimap;
    if (minimap === false) {
        minimapFlag = false;
    }
    const minmap: monaco.editor.IEditorMinimapOptions = {
        enabled: minimapFlag,
    }

    let wordwrapFlag = setting.wordWrap;
    if (wordwrap === true) {
        wordwrapFlag = wordwrap;
    }

    let settings: monaco.editor.IStandaloneEditorConstructionOptions = {
        automaticLayout: true,
        language: getLanguage(language),
        theme: getThemeColor(setting.themeColor),
        lineNumbers: setting.lineNumbers ? "on" : "off",
        wordWrap: wordwrapFlag ? "on" : "off",
        minimap: minmap,
        folding: setting.folding,
        fontSize: setting.fontSize,
        fontFamily: setting.fontFamily,
        fontLigatures: setting.fontLigatures,
        // Controls whether characters are highlighted that can be confused with basic ASCII characters
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
        scrollBeyondLastLine: false,
        'semanticHighlighting.enabled': true,

    }
    return settings;
}

export function getLanguage(extension: string) {
    switch (extension) {
        case "js":
        case "es6":
        case "jsx":
        case "cjs":
        case "mjs":
            return "javascript";
        case "ts":
        case "tsx":
        case "cts":
        case "mts":
            return "typescript";
        case "json":
            return "json";
        case "py":
        case "rpy":
        case "pyu":
        case "cpy":
        case "gyp":
        case "gypi":
		case "python":
            return "python";
        case "css":
            return "css";
        case "html":
        case "htm":
        case "shtml":
        case "xhtml":
        case "mdoc":
        case "jsp":
        case "asp":
        case "aspx":
        case "jshtm":
            return "html";
        case "cpp":
        case "c++":
        case "cc":
        case "cxx":
        case "hpp":
        case "hh":
        case "hxx":
            return "cpp";
        case "graphql":
        case "gql":
            return "graphql";
        case "java":
        case "jav":
            return "java";
        case "php":
        case "php4":
        case "php5":
        case "phtml":
        case "ctp":
            return "php";
        case "sql":
            return "sql";
        case "yaml":
        case "yml":
            return "yaml";
        case "bat":
        case "batch":
            return "bat";
        case "lua":
            return "lua";
        case "rb":
        case "rbx":
        case "rjs":
        case "gemspec":
            return "ruby";
        case "markdown":
        case "mdown":
        case "mkdn":
        case "mkd":
        case "mdwn":
        case "mdtxt":
        case "mdtext":
        case "mdx":
            return "markdown";
        case "r":
        case "rhistory":
        case "rmd":
        case "rprofile":
        case "rt":
            return "r";
        case "ftl":
        case "ftlh":
        case "ftlx":
            return "freemarker2";
        case "rst":
            return "restructuredtext";
        case "hcl":
        case "tf":
        case "tfvars":
            return "hcl";
        case "ini":
        case "properties":
        case "gitconfig":
            return "ini";
        case "pug":
        case "jade":
            return "pug";
        case "dart":
            return "dart";
        case "rs":
        case "rlib":
            return "rust";
        case "less":
            return "less";
        case "cls":
            return "apex";
        case "tcl":
            return "tcl";
        case "abap":
            return "abap";
        case "ecl":
            return "ecl";
        case "pla":
            return "pla";
        case "cmd":
            return "bat";
        case "vb":
            return "vb";
        case "sb":
            return "sb";
        case "m3":
        case "i3":
        case "mg":
        case "ig":
            return "m3";
        case "go":
            return "go";
        case "s":
            return "mips";
        case "pl":
        case "pm":
            return "perl";
        case "wgsl":
            return "wgsl";
        case "twig":
            return "twig";
        case "scss":
            return "scss";
        case "redis":
            return "redis";
        case "sh":
        case "bash":
            return "shell";
        case "scala":
        case "sc":
        case "sbt":
            return "scala";
        case "jl":
            return "julia";
        case "dax":
        case "msdax":
            return "msdax";
        case "lex":
            return "lexon";
        case "cshtml":
            return "razor";
        case "bicep":
            return "bicep";
        case "azcli":
            return "azcli";
        case "swift":
        case "Swift":
            return "swift";
        case "flow":
            return "flow9";
        case "xml":
        case "xsd":
        case "dtd":
        case "ascx":
        case "csproj":
        case "config":
        case "props":
        case "targets":
        case "wxi":
        case "wxl":
        case "wxs":
        case "xaml":
        case "svgz":
        case "opf":
        case "xslt":
        case "xsl":
            return "xml";
        case "kt":
        case "kts":
            return "kotlin";
        case "cypher":
        case "cyp":
            return "cypher";
        case "coffee":
            return "coffeescript";
        case "fs":
        case "fsi":
        case "ml":
        case "mli":
        case "fsx":
        case "fsscript":
            return "fsharp";
        case "scm":
        case "ss":
        case "sch":
        case "rkt":
            return "scheme";
        case "rq":
            return "sparql";
        case "aes":
            return "aes";
        case "liquid":
        case "html.liquid":
            return "liquid";
        case "pas":
        case "p":
        case "pp":
            return "pascal";
        case "ex":
        case "exs":
            return "elixir";
        case "qs":
            return "qsharp";
        case "cs":
        case "csx":
        case "cake":
            return "csharp";
        case "clj":
        case "cljs":
        case "cljc":
        case "edn":
            return "clojure";
        case "mligo":
            return "cameligo";
        case "sol":
            return "sol";
        case "proto":
            return "proto";
        case "dats":
        case "sats":
        case "hats":
            return "postiats";
        case "ligo":
            return "pascaligo";
        case "dockerfile":
            return "dockerfile";
        case "handlebars":
        case "hbs":
            return "handlebars";
        case "pq":
        case "pqm":
            return "powerquery";
        case "m":
            return "objective-c";
        case "sv":
        case "svh":
            return "systemverilog";
        case "v":
        case "vh":
            return "verilog";
        case "st":
        case "iecst":
        case "iecplc":
        case "lc3lib":
            return "st";
        case "c":
        case "h":
            return "c";
        default:
            return "plaintext";
    }
}