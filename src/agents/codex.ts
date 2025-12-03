import path from "node:path";

import type { AgentMeta, AgentParseResult, AgentSpec } from "./types.js";

function parseCodexJson(raw: string): AgentParseResult {
  const lines = raw.split(/\n+/).filter((l) => l.trim().startsWith("{"));
  const texts: string[] = [];
  let meta: AgentMeta | undefined;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
        usage?: unknown;
      };
      // Codex streams multiple events; capture the last agent_message text and
      // the final turn usage for cost/telemetry.
      if (
        ev.type === "item.completed" &&
        ev.item?.type === "agent_message" &&
        typeof ev.item.text === "string"
      ) {
        texts.push(ev.item.text);
      }
      if (
        ev.type === "turn.completed" &&
        ev.usage &&
        typeof ev.usage === "object"
      ) {
        const u = ev.usage as {
          input_tokens?: number;
          cached_input_tokens?: number;
          output_tokens?: number;
        };
        meta = {
          usage: {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cached_input_tokens,
            total:
              (u.input_tokens ?? 0) +
              (u.output_tokens ?? 0) +
              (u.cached_input_tokens ?? 0),
          },
        };
      }
    } catch {
      // ignore
    }
  }

  const finalTexts = texts.length ? texts.map((t) => t.trim()) : undefined;
  return { texts: finalTexts, meta };
}

export const codexSpec: AgentSpec = {
  kind: "codex",
  isInvocation: (argv) => argv.length > 0 && path.basename(argv[0]) === "codex",
  buildArgs: (ctx) => {
    const argv = [...ctx.argv];
    const hasExec = argv.length > 0 && argv[1] === "exec";
    if (!hasExec) {
      argv.splice(1, 0, "exec");
    }
    // Ensure JSON output
    if (!argv.includes("--json")) {
      argv.splice(argv.length - 1, 0, "--json");
    }
    // Safety defaults
    if (!argv.includes("--skip-git-repo-check")) {
      argv.splice(argv.length - 1, 0, "--skip-git-repo-check");
    }
    if (!argv.some((p) => p === "--sandbox" || p.startsWith("--sandbox="))) {
      argv.splice(argv.length - 1, 0, "--sandbox", "read-only");
    }
    return argv;
  },
  parseOutput: parseCodexJson,
};
