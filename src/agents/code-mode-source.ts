/** Validate and transpile guest source in the execution worker. */
import { parse, tokenizer } from "acorn";
import {
  buildCodeModeScriptParseSource,
  parseCodeModeScriptSyntax,
} from "./code-mode-script-syntax.js";
import {
  CODE_MODE_SHELL_SOURCE_ERROR,
  isShellLikeCodeModeSource,
} from "./code-mode-shell-source.js";
import { loadCodeModeTypeScriptRuntime } from "./code-mode-typescript-runtime.js";
import type { CodeModeConfig, CodeModeLanguage } from "./code-mode-worker-types.js";
import { ToolInputError } from "./tool-input-error.js";

function maskCodeLiteralsAndComments(
  code: string,
  typescriptRuntime?: typeof import("typescript"),
): string {
  let masked = code.split("");
  const maskRange = (start: number, end: number, offset = 0) => {
    for (
      let index = Math.max(start - offset, 0);
      index < Math.min(end - offset, masked.length);
      index += 1
    ) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
      }
    }
  };

  try {
    const wrapped = buildCodeModeScriptParseSource(code);
    parse(wrapped.source, {
      ecmaVersion: "latest",
      onComment: (_isBlock, _text, start, end) => maskRange(start, end, wrapped.codeOffset),
      onToken: (token) => {
        // Parse in the real async guest context: standalone tokenization can
        // mistake executable division for a regex after contextual keywords.
        if (
          token.type.label === "string" ||
          token.type.label === "regexp" ||
          token.type.label === "template"
        ) {
          maskRange(token.start, token.end, wrapped.codeOffset);
        }
      },
    });
    return masked.join("");
  } catch {
    // Parser and tokenizer offsets are UTF-16 code units, not Unicode points.
    masked = code.split("");
    if (typescriptRuntime) {
      try {
        const sourceFile = typescriptRuntime.createSourceFile(
          "code-mode.ts",
          code,
          typescriptRuntime.ScriptTarget.ES2022,
          true,
          typescriptRuntime.ScriptKind.TS,
        );
        const visit = (node: import("typescript").Node) => {
          typescriptRuntime.forEachLeadingCommentRange(code, node.getFullStart(), (start, end) =>
            maskRange(start, end),
          );
          typescriptRuntime.forEachTrailingCommentRange(code, node.getEnd(), (start, end) =>
            maskRange(start, end),
          );
          if (
            typescriptRuntime.isStringLiteralLike(node) ||
            typescriptRuntime.isRegularExpressionLiteral(node) ||
            typescriptRuntime.isTemplateHead(node) ||
            typescriptRuntime.isTemplateMiddle(node) ||
            typescriptRuntime.isTemplateTail(node)
          ) {
            maskRange(node.getStart(sourceFile), node.getEnd());
          }
          typescriptRuntime.forEachChild(node, visit);
        };
        visit(sourceFile);
        return masked.join("");
      } catch {
        // A failed TypeScript parse must never expose a partially masked scan.
        return code;
      }
    }

    // Malformed JavaScript needs a conservative lexical pass: never trust a
    // context-free regexp token to hide executable module access.
    try {
      for (const token of tokenizer(code, {
        ecmaVersion: "latest",
        onComment: (_isBlock, _text, start, end) => maskRange(start, end),
      })) {
        if (token.type.label === "string" || token.type.label === "template") {
          maskRange(token.start, token.end);
        }
      }
      return masked.join("");
    } catch {
      // Never inspect partially masked input after a tokenizer failure.
      return code;
    }
  }
}

function isModuleLoaderCallee(callee: import("acorn").Expression | import("acorn").Super): boolean {
  if (callee.type === "ParenthesizedExpression") {
    return isModuleLoaderCallee(callee.expression);
  }
  if (callee.type === "ChainExpression") {
    return isModuleLoaderCallee(callee.expression);
  }
  if (callee.type === "SequenceExpression") {
    const expression = callee.expressions[callee.expressions.length - 1];
    return expression !== undefined && isModuleLoaderCallee(expression);
  }
  return callee.type === "Identifier" && callee.name === "require";
}

function containsModuleAccess(node: import("acorn").AnyNode): boolean {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ImportExpression" ||
    (node.type === "MetaProperty" && node.meta.name === "import") ||
    (node.type === "CallExpression" && isModuleLoaderCallee(node.callee))
  ) {
    return true;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (
          child !== null &&
          typeof child === "object" &&
          "type" in child &&
          typeof child.type === "string" &&
          // SAFETY: Children are taken directly from Acorn's parsed AST.
          containsModuleAccess(child as import("acorn").AnyNode)
        ) {
          return true;
        }
      }
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      "type" in value &&
      typeof value.type === "string" &&
      // SAFETY: Child fields are taken directly from Acorn's parsed AST.
      containsModuleAccess(value as import("acorn").AnyNode)
    ) {
      return true;
    }
  }
  return false;
}

function typeScriptContainsModuleAccess(code: string, ts: typeof import("typescript")): boolean {
  const source = ts.createSourceFile(
    "code-mode.ts",
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const isLoaderCallee = (expression: import("typescript").Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) {
      return isLoaderCallee(expression.expression);
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return isLoaderCallee(expression.right);
    }
    return ts.isIdentifier(expression) && expression.text === "require";
  };

  const visit = (node: import("typescript").Node): boolean => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || isLoaderCallee(node.expression)))
    ) {
      return true;
    }
    return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true;
  };

  return visit(source);
}

function rejectsModuleAccess(
  code: string,
  typescriptRuntime?: typeof import("typescript"),
): boolean {
  const parsed = parseCodeModeScriptSyntax(code);
  if (parsed.ok) {
    // The WASI guest has no host module loader. Only executable module syntax
    // belongs in this early check; ordinary guest methods are not capabilities.
    return containsModuleAccess(parsed.program);
  }
  if (typescriptRuntime) {
    try {
      return typeScriptContainsModuleAccess(code, typescriptRuntime);
    } catch {
      // Keep malformed input on the conservative lexical fallback.
    }
  }
  const source = maskCodeLiteralsAndComments(code, typescriptRuntime);
  return /\bimport\b\s*(?:\.|\(|["'`{*]|\w)|\brequire\b\s*\(/u.test(source);
}

export async function prepareSource(input: {
  code: string;
  language?: CodeModeLanguage;
  config: Pick<CodeModeConfig, "languages">;
  onSourceMap?: (sourceMap: string) => void;
  preflight?: { declarations: string; maxBytes: number };
}): Promise<string> {
  const language = input.language ?? "javascript";
  if (!input.config.languages.includes(language)) {
    throw new ToolInputError(`code mode ${language} input is disabled.`);
  }
  if (language === "javascript") {
    if (rejectsModuleAccess(input.code)) {
      throw new ToolInputError("code mode module access is disabled.");
    }
    if (isShellLikeCodeModeSource(input.code)) {
      throw new ToolInputError(CODE_MODE_SHELL_SOURCE_ERROR);
    }
    return input.code;
  }
  const ts = await loadCodeModeTypeScriptRuntime();
  if (rejectsModuleAccess(input.code, ts)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
  if (input.preflight) {
    const { checkCodeModeTypes } = await import("./code-mode-typecheck.js");
    await checkCodeModeTypes(ts, input.code, input.preflight);
  }
  const transformed = ts.transpileModule(input.code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      sourceMap: true,
    },
    fileName: "user.ts",
    reportDiagnostics: true,
  });
  const diagnostics = transformed.diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    const message = diagnostics
      .map((diagnostic) => {
        const diagnosticMessage = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        if (!diagnostic.file || diagnostic.start === undefined) {
          return diagnosticMessage;
        }
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `openclaw-code-mode:user.ts:${position.line + 1}:${position.character + 1}: ${diagnosticMessage}`;
      })
      .join("\n");
    throw new ToolInputError(`typescript transform failed: ${message}`);
  }
  if (rejectsModuleAccess(transformed.outputText, ts)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
  if (
    isShellLikeCodeModeSource(input.code, transformed.outputText) ||
    isShellLikeCodeModeSource(transformed.outputText)
  ) {
    throw new ToolInputError(CODE_MODE_SHELL_SOURCE_ERROR);
  }
  if (transformed.sourceMapText) {
    input.onSourceMap?.(transformed.sourceMapText);
  }
  return transformed.outputText;
}
