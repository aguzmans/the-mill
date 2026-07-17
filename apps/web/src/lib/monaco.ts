// Monaco setup: bundle the editor + its web workers locally (no CDN), enable JS
// validation, and teach it the Mill SDK so `ctx.` autocompletes.
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { loader } from "@monaco-editor/react";

// Route Monaco's language workers to Vite-bundled worker chunks.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Use the bundled monaco instead of the default CDN loader.
loader.config({ monaco });

/** The Mill SDK surface offered as `ctx.` autocompletions inside a node. */
const CTX_MEMBERS: { label: string; detail: string; insert: string }[] = [
  { label: "log", detail: "ctx.log — structured logging → Redis (live) + Loki", insert: "log.info(${1:message}, ${2:fields})" },
  { label: "secrets", detail: "ctx.secrets — injected by ref; never in git", insert: "secrets.${1:NAME}" },
  { label: "inputs", detail: "ctx.inputs — upstream outputs by node key (fan-in)", insert: "inputs[${1:'nodeKey'}]" },
  { label: "state", detail: "ctx.state — node-boundary journal (retry-safe)", insert: "state" },
  { label: "http", detail: "ctx.http — HTTP helper", insert: "http" },
  { label: "db", detail: "ctx.db — database helper", insert: "db.${1:query}(${2})" },
  { label: "email", detail: "ctx.email — email helper", insert: "email.send(${1})" },
  { label: "now", detail: "ctx.now — Date at run start", insert: "now" },
];

let configured = false;

/** Called from Editor.beforeMount — runs once for the whole app. */
export function configureMonaco(m: typeof monaco) {
  if (configured) return;
  configured = true;

  // The `typescript` namespace is populated at runtime by monaco's TS contribution,
  // but its barrel type is a deprecated placeholder — cast to reach the real API.
  type TsLang = {
    javascriptDefaults: {
      setDiagnosticsOptions(o: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void;
      setCompilerOptions(o: Record<string, unknown>): void;
    };
    ScriptTarget: { ES2020: number };
  };
  const ts = (m.languages as unknown as { typescript: TsLang }).typescript;
  const js = ts.javascriptDefaults;
  js.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
  js.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    allowNonTsExtensions: true,
    checkJs: true,
    lib: ["es2020", "dom"],
  });

  // Mill-aware autocompletion: offer the SDK members right after `ctx.`.
  m.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const line = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      if (!/\bctx\.$/.test(line)) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        suggestions: CTX_MEMBERS.map((s) => ({
          label: s.label,
          kind: m.languages.CompletionItemKind.Property,
          detail: s.detail,
          insertText: s.insert,
          insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}
