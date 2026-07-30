import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const promptEvent = (prompt: string) => ({ prompt, messages: [] });

describe("before_prompt_build reentrancy", () => {
  it("runs each handler once when a handler starts a nested prompt build", async () => {
    const firstHandler = vi.fn(async () => {
      await runner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return { prependContext: "first" };
    });
    const secondHandler = vi.fn(() => ({ appendContext: "second" }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: firstHandler,
          pluginId: "first",
          priority: 10,
        },
        {
          hookName: "before_prompt_build",
          handler: secondHandler,
          pluginId: "second",
          priority: 1,
        },
      ]),
    );

    await expect(
      runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX),
    ).resolves.toEqual({
      systemPrompt: undefined,
      prependContext: "first",
      appendContext: "second",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("keeps sibling hook families and other runners active during dispatch", async () => {
    const turnPrepare = vi.fn(() => ({ prependContext: "turn" }));
    const heartbeat = vi.fn(() => ({ appendContext: "heartbeat" }));
    const otherPromptBuild = vi.fn(() => ({ prependContext: "other runner" }));
    const otherRunner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: otherPromptBuild,
          pluginId: "other",
        },
      ]),
    );
    const promptBuild = vi.fn(async () => {
      await runner.runAgentTurnPrepare(
        { prompt: "nested", messages: [], queuedInjections: [] },
        TEST_PLUGIN_AGENT_CTX,
      );
      await runner.runHeartbeatPromptContribution(
        { heartbeatName: "heartbeat" },
        TEST_PLUGIN_AGENT_CTX,
      );
      await otherRunner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return {};
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: promptBuild,
          pluginId: "prompt",
        },
        {
          hookName: "agent_turn_prepare",
          handler: turnPrepare,
          pluginId: "turn",
        },
        {
          hookName: "heartbeat_prompt_contribution",
          handler: heartbeat,
          pluginId: "heartbeat",
        },
      ]),
    );

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);

    expect(promptBuild).toHaveBeenCalledOnce();
    expect(turnPrepare).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(otherPromptBuild).toHaveBeenCalledOnce();
  });

  it("allows detached descendants to dispatch after the outer call settles", async () => {
    let releaseDetached: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedDispatch: Promise<unknown> | undefined;
    const promptBuild = vi.fn(async (event: unknown) => {
      const prompt = (event as { prompt: string }).prompt;
      if (prompt === "outer") {
        detachedDispatch = (async () => {
          await detachedGate;
          return await runner.runBeforePromptBuild(promptEvent("detached"), TEST_PLUGIN_AGENT_CTX);
        })();
      }
      return { prependContext: prompt };
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: promptBuild,
          pluginId: "prompt",
        },
      ]),
    );

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);
    releaseDetached?.();
    const pendingDetachedDispatch = detachedDispatch;
    if (!pendingDetachedDispatch) {
      throw new Error("detached prompt dispatch was not created");
    }
    await expect(pendingDetachedDispatch).resolves.toEqual({
      systemPrompt: undefined,
      prependContext: "detached",
      appendContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(promptBuild).toHaveBeenCalledTimes(2);
  });
});
