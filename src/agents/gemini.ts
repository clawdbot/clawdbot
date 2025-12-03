import path from "node:path";

import type { AgentParseResult, AgentSpec } from "./types.js";

const GEMINI_BIN = "gemini";
export const GEMINI_IDENTITY_PREFIX =
  "You are Gemini responding for warelay. Keep WhatsApp replies concise (<1500 chars). If the prompt contains media paths or a Transcript block, use them. If this was a heartbeat probe and nothing needs attention, reply with exactly HEARTBEAT_OK.";

// Gemini CLI currently prints plain text; --output json is flaky across versions, so we
// keep parsing minimal and let MEDIA token stripping happen later in the pipeline.
function parseGeminiOutput(raw: string): AgentParseResult {
  const trimmed = raw.trim();
  const text = trimmed || undefined;
  return {
    texts: text ? [text] : undefined,
    meta: undefined,
  } satisfies AgentParseResult;
}

export const geminiSpec: AgentSpec = {
  kind: "gemini",
  isInvocation: (argv) =>
    argv.length > 0 && path.basename(argv[0]) === GEMINI_BIN,
  buildArgs: (ctx) => {
    const argv = [...ctx.argv];
    const body = argv[ctx.bodyIndex] ?? "";
    const beforeBody = argv.slice(0, ctx.bodyIndex);
    const afterBody = argv.slice(ctx.bodyIndex + 1);

    if (ctx.format) {
      const hasOutput =
        beforeBody.some(
          (p) => p === "--output-format" || p.startsWith("--output-format="),
        ) ||
        afterBody.some(
          (p) => p === "--output-format" || p.startsWith("--output-format="),
        );
      if (!hasOutput) {
        beforeBody.push("--output-format", ctx.format);
      }
    }

    const shouldPrependIdentity = !(ctx.sendSystemOnce && ctx.systemSent);
    const bodyWithIdentity =
      shouldPrependIdentity && body
        ? [ctx.identityPrefix ?? GEMINI_IDENTITY_PREFIX, body]
            .filter(Boolean)
            .join("\n\n")
        : body;

    return [...beforeBody, bodyWithIdentity, ...afterBody];
  },
  parseOutput: parseGeminiOutput,
};
