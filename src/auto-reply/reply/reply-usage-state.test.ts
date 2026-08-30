import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as usageFormat from "../../utils/usage-format.js";
import {
  buildReplyUsageState,
  consumeReplyUsageState,
  recordReplyUsageState,
} from "./reply-usage-state.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("reply usage state handoff", () => {
  it.each([
    { name: "unrecorded cost", costUsd: undefined, expectedCost: 1 },
    { name: "recorded cost", costUsd: 0.125, expectedCost: 0.125 },
    { name: "recorded zero cost", costUsd: 0, expectedCost: 0 },
  ])("prices the selected agent in an explicit fleet: $name", ({ costUsd, expectedCost }) => {
    const costLookup = vi.spyOn(usageFormat, "resolveModelCostConfig");
    try {
      const snapshot = buildReplyUsageState({
        config: {
          agents: {
            ownership: "explicit",
            entries: { main: {}, other: {} },
          },
          models: {
            providers: {
              fixture: {
                baseUrl: "https://fixture.invalid",
                models: [
                  {
                    id: "priced",
                    name: "Priced",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1,
                    maxTokens: 1,
                  },
                ],
              },
            },
          },
        } as OpenClawConfig,
        agentDir: "/tmp/openclaw-main-agent",
        workspaceDir: "/tmp/openclaw-main-workspace",
        provider: "fixture",
        model: "priced",
        agentId: "main",
        sessionId: "session-priced",
        costUsd,
        usage: { input: 1_000_000, output: 0 },
      });

      expect(snapshot.turnUsd).toBe(expectedCost);
      if (costUsd !== undefined) {
        expect(costLookup).not.toHaveBeenCalled();
      } else {
        expect(costLookup).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            workspaceDir: "/tmp/openclaw-main-workspace",
          }),
        );
      }
    } finally {
      costLookup.mockRestore();
    }
  });

  it("requires exact run correlation", () => {
    const snapshot = { provider: "openai", model: "gpt-5.5" };

    recordReplyUsageState("run-correlation", snapshot);

    expect(consumeReplyUsageState()).toBeUndefined();
    expect(consumeReplyUsageState("run-b")).toBeUndefined();
    expect(consumeReplyUsageState("run-correlation")).toBe(snapshot);
  });

  it("ignores snapshots without a run id", () => {
    recordReplyUsageState(undefined, { provider: "openai" });

    expect(consumeReplyUsageState()).toBeUndefined();
  });

  it("expires snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordReplyUsageState("run-expiry", { provider: "openai" });

    vi.setSystemTime(5 * 60_000 + 1);

    expect(consumeReplyUsageState("run-expiry")).toBeUndefined();
  });

  it("evicts the oldest snapshots above the handoff capacity", () => {
    const entryCount = 1_025;
    for (let index = 0; index < entryCount; index += 1) {
      recordReplyUsageState(`run-capacity-${index}`, {
        provider: "openai",
        model: `model-${index}`,
      });
    }

    expect(consumeReplyUsageState("run-capacity-0")).toBeUndefined();
    expect(consumeReplyUsageState("run-capacity-1")?.model).toBe("model-1");
    expect(consumeReplyUsageState(`run-capacity-${entryCount - 1}`)?.model).toBe(
      `model-${entryCount - 1}`,
    );
  });
});
