import { parseExpressionAt, tokenizer, tokTypes, type TokenType } from "acorn";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactInputTextWithSourcePolicy, redactToolPayloadTextWithConfig } from "./redact.js";

// This bounds syntax work, not accepted tool input. Oversized or unlexable source
// keeps diagnostic masking; syntax uncertainty must never exempt a credential.
const MAX_SOURCE_REDACTION_SYNTAX_CHARS = 131_072;

function createSourceAssignmentMatcher(): (text: string, offset: number) => boolean {
  let parsedText: string | undefined;
  const tokens = new Map<number, TokenType>();
  return (text, offset) => {
    if (text !== parsedText) {
      parsedText = text;
      tokens.clear();
      if (text.length <= MAX_SOURCE_REDACTION_SYNTAX_CHARS) {
        try {
          for (const token of tokenizer(text, { ecmaVersion: "latest" })) {
            tokens.set(token.start, token.type);
          }
        } catch {
          tokens.clear();
        }
      }
    }
    const token = tokens.get(offset);
    if (!token) {
      // In particular, assignment-looking text inside strings/comments is not source syntax.
      return false;
    }
    if (token === tokTypes.name) {
      // Includes TypeScript type names and generic calls without loading its compiler.
      return true;
    }
    try {
      const expression = parseExpressionAt(text, offset, {
        ecmaVersion: "latest",
        allowAwaitOutsideFunction: true,
      });
      // Boolean/null state survives; other literal matches still use diagnostic masking.
      return expression.type === "Literal"
        ? typeof expression.value === "boolean" || expression.raw === "null"
        : expression.type !== "TemplateLiteral";
    } catch {
      return false;
    }
  };
}

export function redactSourceInputTextWithConfig(
  text: string,
  loggingConfig?: OpenClawConfig["logging"],
): string {
  if (text.length > MAX_SOURCE_REDACTION_SYNTAX_CHARS) {
    return redactToolPayloadTextWithConfig(text, loggingConfig);
  }
  return redactInputTextWithSourcePolicy(text, loggingConfig, createSourceAssignmentMatcher());
}
