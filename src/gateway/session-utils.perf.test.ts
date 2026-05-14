import path from "node:path";
import { describe, test, expect, vi } from "vitest";
import * as thinking from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import * as usageFormat from "../utils/usage-format.js";
import { listSessionsFromStore } from "./session-utils.js";

/**
 * Regression smoke for the per-list rowContext resolver cache. The bug we are
 * guarding against is O(rows) scaling of deterministic resolvers whose results
 * only depend on `(provider, model[, agentId])`: with N sessions sharing K
 * unique model tuples, the cached path must perform at most O(K) underlying
 * resolver calls -- not O(N).
 *
 * We assert call counts directly instead of a wall-time bound because shared
 * CI runners cannot give a stable wall-time signal, and call-count regressions
 * are the actual scaling failure mode we care about.
 */
describe("listSessionsFromStore resolver cache", () => {
  test("collapses non-lightweight per-row resolver work to O(unique provider/model tuples)", async () => {
    await withStateDirEnv("openclaw-perf-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "google-vertex/gemini-3-flash-preview" } },
        },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);

      const tuples: Array<{ modelProvider: string; model: string }> = [
        { modelProvider: "google-vertex", model: "gemini-3-flash-preview" },
        { modelProvider: "openai", model: "gpt-5" },
        { modelProvider: "anthropic", model: "claude-opus-4-7" },
        { modelProvider: "openrouter", model: "z-ai/glm-5" },
        { modelProvider: "google", model: "gemini-2.5-pro" },
      ];

      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      const rowCount = 30;
      for (let i = 0; i < rowCount; i++) {
        const tuple = tuples[i % tuples.length];
        store[`agent:default:webchat:dm:${i}`] = {
          updatedAt: now - i,
          modelProvider: tuple.modelProvider,
          model: tuple.model,
          inputTokens: 100,
          outputTokens: 50,
        } as SessionEntry;
      }

      const thinkingSpy = vi.spyOn(thinking, "listThinkingLevelOptions");
      const costSpy = vi.spyOn(usageFormat, "resolveModelCostConfig");
      try {
        const result = listSessionsFromStore({
          cfg,
          storePath: path.join(stateDir, "sessions.json"),
          store,
          // sessions.list bounds responses to 100 rows by default; the perf
          // smoke explicitly opts into the full set so the non-lightweight
          // row builder exercises the display-identity, thinking-default, and
          // model-cost caches at scale.
          opts: { limit: rowCount },
        });
        expect(result.sessions.length).toBe(rowCount);

        // The cache keys on rowContext are (provider, model) or
        // (agentId, provider, model). With K=5 unique tuples we must see at
        // most a small constant number of resolver calls, not O(N=30). A
        // pre-cache regression would scale linearly and easily exceed the
        // threshold below.
        const cacheCallCeiling = tuples.length * 4;
        expect(thinkingSpy.mock.calls.length).toBeLessThanOrEqual(cacheCallCeiling);
        expect(costSpy.mock.calls.length).toBeLessThanOrEqual(cacheCallCeiling);
      } finally {
        thinkingSpy.mockRestore();
        costSpy.mockRestore();
      }
    });
  });
});
