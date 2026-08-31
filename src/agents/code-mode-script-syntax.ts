import { parse, type Position, type Program } from "acorn";

type AcornSyntaxError = SyntaxError & { loc: Position };

type CodeModeScriptParseResult =
  | { ok: true; program: Program }
  | { ok: false; message: string; line: number; column: number };

/** Mirrors the worker's async-arrow body grammar so valid top-level await/return stay legal. */
export function buildCodeModeScriptParseSource(code: string): {
  source: string;
  codeOffset: number;
} {
  const prefix = "(async () => {\n";
  return { source: `${prefix}${code}\n})`, codeOffset: prefix.length };
}

export function parseCodeModeScriptSyntax(code: string): CodeModeScriptParseResult {
  const { source } = buildCodeModeScriptParseSource(code);
  try {
    return {
      ok: true,
      program: parse(source, { ecmaVersion: "latest" }),
    };
  } catch (error) {
    const syntaxError = error as AcornSyntaxError;
    return {
      ok: false,
      message: syntaxError.message.replace(/ \(\d+:\d+\)$/u, ""),
      line: syntaxError.loc.line - 1,
      column: syntaxError.loc.column,
    };
  }
}
