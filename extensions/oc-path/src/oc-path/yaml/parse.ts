import { LineCounter, parseDocument } from "yaml";
import type { Diagnostic } from "../ast.js";
import type { YamlAst } from "./ast.js";

export interface YamlParseResult {
  readonly ast: YamlAst;
  readonly diagnostics: readonly Diagnostic[];
}

export function parseYaml(raw: string): YamlParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
  });
  const diagnostics: Diagnostic[] = [];
  for (const w of doc.warnings) {
    diagnostics.push({
      line: w.linePos?.[0]?.line ?? 1,
      message: w.message,
      severity: "warning",
      code: "OC_YAML_WARN",
    });
  }
  for (const e of doc.errors) {
    diagnostics.push({
      line: e.linePos?.[0]?.line ?? 1,
      message: e.message,
      severity: "error",
      code: "OC_YAML_PARSE_FAILED",
    });
  }
  return { ast: { kind: "yaml", raw, doc, lineCounter }, diagnostics };
}
