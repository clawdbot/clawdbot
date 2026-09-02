import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { resolveClaudeCliThinkingEnv } from "./cli-shared.js";

describe("Claude CLI execution environment", () => {
  it("keeps the prepared child environment stable across the real SDK's first import", async () => {
    const prepared = await buildAnthropicCliBackend().prepareExecution?.({
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "claude-cli",
      modelId: "claude-sonnet-4-6",
      executionMode: "agent",
    });
    // A separate process preserves the first-import order even if another test loaded the SDK.
    const changedKeys = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          const preparedEnv = JSON.parse(process.argv[1]);
          const before = { ...process.env, ...preparedEnv };
          await import(process.argv[2]);
          const after = { ...process.env, ...preparedEnv };
          const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
          process.stdout.write(JSON.stringify(keys.filter((key) => before[key] !== after[key])));
        `,
        JSON.stringify(prepared?.env ?? {}),
        pathToFileURL(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"))
          .href,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NoDefaultCurrentDirectoryInExePath: undefined },
      },
    );

    expect(JSON.parse(changedKeys)).toEqual([]);
  });

  it.each([
    ["high", { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "16384" }],
    ["off", { MAX_THINKING_TOKENS: "0" }],
    ["adaptive", undefined],
  ] as const)("maps %s thinking to Claude Code's process environment", (level, expected) => {
    expect(resolveClaudeCliThinkingEnv(level, "claude-opus-4-8")).toEqual(expected);
  });

  it.each(["off", "high", "max"] as const)(
    "leaves mandatory-adaptive Fable thinking %s to Claude Code effort args",
    (level) => {
      expect(resolveClaudeCliThinkingEnv(level, "claude-fable-5")).toBeUndefined();
    },
  );
});
