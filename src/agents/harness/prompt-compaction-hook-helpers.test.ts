import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("forwards a per-turn tool restriction to native harness adapters", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({ toolsAllow: [] }),
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "answer directly",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
    });

    expect(result.toolsAllow).toEqual([]);
  });

  it("retains an empty prompt range without hooks", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
    });

    expect(result).toEqual({
      prompt: "",
      developerInstructions: "base instructions",
      promptInputRange: { start: 0, end: 0 },
    });
  });

  it("runs heartbeat_prompt_contribution on a heartbeat turn and prepends its contribution", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => ({ prependContext: "Run the base-heartbeat skill." }),
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "Read HEARTBEAT.md.",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(result.prompt).toBe("Run the base-heartbeat skill.\n\nRead HEARTBEAT.md.");
    // The heartbeat contribution affects only the prompt, not developer instructions.
    expect(result.developerInstructions).toBe("base instructions");
  });

  it("runs heartbeat contributions before other prompt-build hooks", async () => {
    const calls: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => {
            calls.push("heartbeat");
            return { prependContext: "heartbeat context" };
          },
        },
        {
          hookName: "before_prompt_build",
          handler: () => {
            calls.push("before_prompt_build");
            return { prependContext: "prompt context" };
          },
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(calls).toEqual(["heartbeat", "before_prompt_build"]);
    expect(result.prompt).toBe("heartbeat context\n\nprompt context\n\nhello");
  });

  it("skips heartbeat_prompt_contribution off a heartbeat turn", async () => {
    const handler = vi.fn(() => ({ prependContext: "should not appear" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "heartbeat_prompt_contribution", handler }]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.prompt).toBe("hello");
  });
});
