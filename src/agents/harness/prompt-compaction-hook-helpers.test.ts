import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import type { PluginHookBeforePromptBuildEvent } from "../../plugins/types.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
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

  // Codex/Copilot harnesses build before_prompt_build events through
  // this shared helper. Without forwarding rawBody, channel runs on those
  // runtimes would expose `undefined` while the embedded runner exposes the
  // clean user text, breaking the documented hook contract.
  it("forwards rawBody to the before_prompt_build event for channel runs", async () => {
    const captured: PluginHookBeforePromptBuildEvent[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: vi.fn((event: unknown) => {
            captured.push(event as PluginHookBeforePromptBuildEvent);
            return undefined;
          }),
        },
      ]),
    );

    await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "decorated prompt with metadata",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { messageProvider: "discord" },
      rawBody: "hello rawbody",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.rawBody).toBe("hello rawbody");
  });

  it("passes undefined rawBody for non-channel runs", async () => {
    const captured: PluginHookBeforePromptBuildEvent[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: vi.fn((event: unknown) => {
            captured.push(event as PluginHookBeforePromptBuildEvent);
            return undefined;
          }),
        },
      ]),
    );

    await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "[OpenClaw heartbeat poll]",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveProperty("rawBody");
    expect(captured[0]?.rawBody).toBeUndefined();
  });
});
