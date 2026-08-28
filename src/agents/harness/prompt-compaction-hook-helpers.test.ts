import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("runs a lazy builder with hook tool policy while preserving replacement order", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({
            appendSystemContext: "after replacement",
            prependSystemContext: "before replacement",
            systemPrompt: "hook replacement",
            toolsAllow: ["read"],
          }),
        },
      ]),
    );
    const build = vi.fn(() => "policy-filtered base");

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "answer directly",
      developerInstructions: { build },
      messages: [],
      ctx: {},
    });

    expect(build).toHaveBeenCalledWith({ toolsAllow: ["read"] });
    expect(result).toMatchObject({
      toolsAllow: ["read"],
      developerInstructions:
        "---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nbefore replacement\n\n---\n\nhook replacement\n\n---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nafter replacement\n\n---",
    });
    expect(result.developerInstructions).not.toContain("policy-filtered base");
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

  it("runs authorized enrichment after restrictive hooks finalize the tool surface", async () => {
    const calls: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => {
            calls.push("restrict");
            return { prependContext: "regular context", toolsAllow: ["message"] };
          },
        },
        {
          hookName: "before_prompt_build",
          requiresToolAuthority: true,
          handler: (_event, ctx) => {
            calls.push("enrich");
            expect((ctx as PluginHookAgentContext).toolAuthority?.allows("memory_search")).toBe(
              false,
            );
            return { prependContext: "authorized context" };
          },
        },
      ]),
    );
    let activeToolNames: string[] = [];

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: {
        build: ({ toolsAllow }) => {
          calls.push("build");
          activeToolNames = toolsAllow ?? [];
          return "base instructions";
        },
      },
      messages: [],
      ctx: {},
      toolAuthority: {
        fingerprint: "turn-authority",
        activeToolNames: () => activeToolNames,
        assertActive: () => undefined,
      },
    });

    expect(calls).toEqual(["restrict", "build", "enrich"]);
    expect(result.prompt).toBe("regular context\n\nauthorized context\n\nhello");
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
