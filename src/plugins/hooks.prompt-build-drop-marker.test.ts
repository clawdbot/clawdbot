/**
 * Test: a dropped before_prompt_build contribution is visible in the prompt.
 *
 * The runner is fail-open around prompt-build hooks: a throwing handler and a
 * re-entrant dispatch both end with the contribution discarded and only a log
 * line written. Plugins use this hook to inject the agent's work queue, so a
 * silent discard leaves a prompt that still looks complete while the queue is
 * gone. These tests assert the loss reaches the prompt itself.
 *
 * The timeout path shares this seam; it is covered where the prompt-build
 * timeout budget is already exercised, in hooks.model-override-wiring.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { buildPromptBuildDropMarker } from "./hook-prompt-build-drop-marker.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const promptEvent = { prompt: "outer", messages: [] };

describe("before_prompt_build drop markers", () => {
  it("marks a throwing handler and keeps the surviving handler's contribution", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => {
            throw new Error("hook exploded");
          },
          pluginId: "beads",
          priority: 10,
        },
        {
          hookName: "before_prompt_build",
          handler: () => ({ prependContext: "healthy block" }),
          pluginId: "healthy",
          priority: 1,
        },
      ]),
      { logger },
    );

    const result = await runner.runBeforePromptBuild(promptEvent, TEST_PLUGIN_AGENT_CTX);

    expect(result?.prependContext).toBe(
      `${buildPromptBuildDropMarker({ reason: "failed", pluginId: "beads" })}\n\nhealthy block`,
    );
    // The marker is additive: logging still records the failure for operators.
    expect(logger.error).toHaveBeenCalledWith(
      "[hooks] before_prompt_build handler from beads failed: hook exploded",
    );
  });

  it("marks a re-entrant dispatch once for the whole skipped hook list", async () => {
    let nested: Awaited<ReturnType<typeof runner.runBeforePromptBuild>>;
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => {
            nested = await runner.runBeforePromptBuild(
              { prompt: "nested", messages: [] },
              TEST_PLUGIN_AGENT_CTX,
            );
            return { prependContext: "outer block" };
          },
          pluginId: "beads",
        },
        {
          hookName: "before_prompt_build",
          handler: () => ({ prependContext: "second block" }),
          pluginId: "second",
        },
      ]),
    );

    const outer = await runner.runBeforePromptBuild(promptEvent, TEST_PLUGIN_AGENT_CTX);

    // Named per-plugin markers would be wrong here: the guard skipped both
    // handlers at once, so the nested prompt gets one dispatch-level line.
    expect(nested?.prependContext).toBe(buildPromptBuildDropMarker({ reason: "reentrant" }));
    expect(outer?.prependContext).toBe("outer block\n\nsecond block");
  });
});
