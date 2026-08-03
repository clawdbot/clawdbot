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

  it("skips heartbeat_prompt_contribution for commitment-only heartbeat lifecycle turns", async () => {
    const heartbeatHandler = vi.fn(() => ({ prependContext: "global heartbeat context" }));
    const promptHandler = vi.fn(() => ({ prependContext: "turn policy" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "heartbeat_prompt_contribution", handler: heartbeatHandler },
        { hookName: "before_prompt_build", handler: promptHandler },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "due commitment",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
      bootstrapContextRunKind: "commitment-only",
    });

    expect(heartbeatHandler).not.toHaveBeenCalled();
    expect(promptHandler).toHaveBeenCalledTimes(1);
    expect(result.prompt).toBe("turn policy\n\ndue commitment");
  });

  it("marks a failed handler in the assembled prompt without leaking its error text", async () => {
    const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "leaky-plugin",
          handler: () => {
            throw new Error(`bd ready failed: ${secret}`);
          },
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(result.prompt).toContain("hello");
    expect(result.prompt).toContain('<dropped_plugin_context hook="before_prompt_build">');
    expect(result.prompt).toContain("leaky-plugin (handler-failed)");
    expect(result.prompt).not.toContain("sk-live-9f3c");
    expect(result.prompt).not.toContain("internal.example");
    expect(result.prompt).not.toContain("bd ready failed");
  });

  it("bounds the marker in the assembled prompt when many handlers fail", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry(
        Array.from({ length: 30 }, (_unused, index) => ({
          hookName: "before_prompt_build",
          pluginId: `bulk-plugin-${index}`,
          handler: () => {
            throw new Error(`handler ${index} exploded`);
          },
        })),
      ),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    const marker = result.prompt.slice(
      result.prompt.indexOf('<dropped_plugin_context hook="before_prompt_build">'),
    );
    expect(marker.match(/\(handler-failed\)/gu)).toHaveLength(5);
    expect(marker).toContain("+25 more");
    expect(new TextEncoder().encode(marker).length).toBeLessThanOrEqual(640);
    expect(result.prompt).not.toContain("exploded");
  });
});
