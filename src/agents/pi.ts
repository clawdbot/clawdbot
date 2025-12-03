import path from "node:path";

import type { AgentMeta, AgentParseResult, AgentSpec } from "./types.js";

type PiAssistantMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input?: number; output?: number };
  model?: string;
  provider?: string;
  stopReason?: string;
};

function parsePiJson(raw: string): AgentParseResult {
  const lines = raw.split(/\n+/).filter((l) => l.trim().startsWith("{"));

  // Collect only completed assistant messages (skip streaming updates/toolcalls).
  const texts: string[] = [];
  let lastAssistant: PiAssistantMessage | undefined;
  let lastPushed: string | undefined;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: PiAssistantMessage;
      };

      const isAssistantMessage =
        (ev.type === "message" || ev.type === "message_end") &&
        ev.message?.role === "assistant" &&
        Array.isArray(ev.message.content);

      if (!isAssistantMessage) continue;

      const msg = ev.message as PiAssistantMessage;
      const msgText = msg.content
        ?.filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (msgText && msgText !== lastPushed) {
        texts.push(msgText);
        lastPushed = msgText;
        lastAssistant = msg;
      }
    } catch {
      // ignore malformed lines
    }
  }

  const meta: AgentMeta | undefined =
    lastAssistant && texts.length
      ? {
          model: lastAssistant.model,
          provider: lastAssistant.provider,
          stopReason: lastAssistant.stopReason,
          usage: lastAssistant.usage,
        }
      : undefined;

  return { texts, meta };
}

export const piSpec: AgentSpec = {
  kind: "pi",
  isInvocation: (argv) => {
    if (argv.length === 0) return false;
    const base = path.basename(argv[0]).replace(/\.(m?js)$/i, "");
    return base === "pi" || base === "tau";
  },
  buildArgs: (ctx) => {
    const argv = [...ctx.argv];
    // Non-interactive print + JSON
    if (!argv.includes("-p") && !argv.includes("--print")) {
      argv.splice(argv.length - 1, 0, "-p");
    }
    if (
      ctx.format === "json" &&
      !argv.includes("--mode") &&
      !argv.some((a) => a === "--mode")
    ) {
      argv.splice(argv.length - 1, 0, "--mode", "json");
    }
    // Session defaults
    // Identity prefix optional; Pi usually doesn't need it, but allow injection
    if (!(ctx.sendSystemOnce && ctx.systemSent) && argv[ctx.bodyIndex]) {
      const existingBody = argv[ctx.bodyIndex];
      argv[ctx.bodyIndex] = [ctx.identityPrefix, existingBody]
        .filter(Boolean)
        .join("\n\n");
    }
    return argv;
  },
  parseOutput: parsePiJson,
};
