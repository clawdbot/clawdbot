/** Guardrail tests that keep ACP/session binding flows off legacy thread-binding APIs. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type GuardedSource = {
  path: string;
  forbiddenPatterns: RegExp[];
};

const GUARDED_SOURCES: GuardedSource[] = [
  {
    path: "agents/acp-spawn.ts",
    forbiddenPatterns: [/\bgetThreadBindingManager\b/, /\bparseDiscordTarget\b/],
  },
  {
    path: "auto-reply/reply/commands-acp/lifecycle.ts",
    forbiddenPatterns: [/\bgetThreadBindingManager\b/, /\bunbindThreadBindingsBySessionKey\b/],
  },
  {
    path: "auto-reply/reply/commands-acp/targets.ts",
    forbiddenPatterns: [/\bgetThreadBindingManager\b/],
  },
  {
    path: "auto-reply/reply/commands-subagents/action-focus.ts",
    forbiddenPatterns: [/\bgetThreadBindingManager\b/],
  },
];

describe("ACP/session binding architecture guardrails", () => {
  it("keeps ACP/focus flows off Discord thread-binding manager APIs", () => {
    for (const source of GUARDED_SOURCES) {
      const absolutePath = resolve(ROOT_DIR, source.path);
      const text = readFileSync(absolutePath, "utf8");
      for (const pattern of source.forbiddenPatterns) {
        expect(text).not.toMatch(pattern);
      }
    }
  });
});
