import path from "node:path";

import {
  OPENCODE_BIN,
  OPENCODE_IDENTITY_PREFIX,
  parseOpencodeJson,
  summarizeOpencodeMetadata,
} from "../auto-reply/opencode.js";
import type { AgentMeta, AgentSpec } from "./types.js";

function toMeta(
  parsed: ReturnType<typeof parseOpencodeJson>,
): AgentMeta | undefined {
  const summary = summarizeOpencodeMetadata(parsed.meta);
  return summary ? { extra: { summary } } : undefined;
}

export const opencodeSpec: AgentSpec = {
  kind: "opencode",
  isInvocation: (argv) =>
    argv.length > 0 && path.basename(argv[0]) === OPENCODE_BIN,
  buildArgs: (ctx) => {
    // Split around the body so we can insert flags without losing the prompt.
    const argv = [...ctx.argv];
    const body = argv[ctx.bodyIndex] ?? "";
    const beforeBody = argv.slice(0, ctx.bodyIndex);
    const afterBody = argv.slice(ctx.bodyIndex + 1);
    const wantsJson = ctx.format === "json";

    // Ensure format json for parsing
    if (wantsJson) {
      const hasFormat = [...beforeBody, body, ...afterBody].some(
        (part) => part === "--format" || part.startsWith("--format="),
      );
      if (!hasFormat) {
        beforeBody.push("--format", "json");
      }
    }

    // Session args default to --session
    // Identity prefix
    // Opencode streams text tokens; we still seed an identity so the agent
    // keeps context on first turn.
    const shouldPrependIdentity = !(ctx.sendSystemOnce && ctx.systemSent);
    const bodyWithIdentity =
      shouldPrependIdentity && body
        ? [ctx.identityPrefix ?? OPENCODE_IDENTITY_PREFIX, body]
            .filter(Boolean)
            .join("\n\n")
        : body;

    return [...beforeBody, bodyWithIdentity, ...afterBody];
  },
  parseOutput: (rawStdout) => {
    const parsed = parseOpencodeJson(rawStdout);
    const text = parsed.text ?? rawStdout.trim();
    return {
      texts: text ? [text.trim()] : undefined,
      meta: toMeta(parsed),
    };
  },
};
