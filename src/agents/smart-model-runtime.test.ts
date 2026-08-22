import { describe, expect, it } from "vitest";
import { executeWithModelFailover, selectRuntimeModels } from "./smart-model-runtime.js";
import type { SmartModelCandidate } from "./smart-model-router.js";

const candidates: SmartModelCandidate[] = [
  {
    provider: "openrouter",
    model: "free-coder",
    free: true,
    available: true,
    capabilities: { coding: 0.95, chat: 0.8 },
    latencyMs: 200,
    successRate: 0.9,
  },
  {
    provider: "openrouter",
    model: "free-reasoner",
    free: true,
    available: true,
    capabilities: { reasoning: 0.98, chat: 0.8 },
    latencyMs: 400,
    successRate: 0.9,
  },
  {
    provider: "openrouter",
    model: "paid-coder",
    free: false,
    available: true,
    capabilities: { coding: 1 },
    latencyMs: 100,
    successRate: 0.99,
  },
];

describe("smart model runtime", () => {
  it("orders candidates by task capability while respecting free-only", () => {
    const ranked = selectRuntimeModels({
      candidates,
      task: "coding",
      policy: "free-only",
    });
    expect(ranked.map((model) => model.model)).toEqual(["free-coder"]);
  });

  it("keeps paid models out of free-first unless fallback is explicitly enabled", () => {
    const ranked = selectRuntimeModels({
      candidates,
      task: "coding",
      policy: "free-first",
      allowPaidFallback: false,
    });
    expect(ranked.every((model) => model.free)).toBe(true);
  });

  it("moves a preferred eligible model to the front", () => {
    const ranked = selectRuntimeModels({
      candidates,
      task: "reasoning",
      policy: "free-only",
      preferredModel: "openrouter/free-reasoner",
    });
    expect(ranked[0]?.model).toBe("free-reasoner");
  });

  it("fails over after a transient provider error", async () => {
    const calls: string[] = [];
    const result = await executeWithModelFailover(
      {
        candidates,
        task: "coding",
        policy: "free-only",
      },
      async (model) => {
        calls.push(model.model);
        if (calls.length === 1) {
          const error = new Error("rate limit");
          Object.assign(error, { status: 429 });
          throw error;
        }
        return "ok";
      },
    );

    expect(result.value).toBe("ok");
    expect(result.failedOver).toBe(true);
    expect(result.attempts).toHaveLength(2);
  });

  it("stops on authentication failures", async () => {
    await expect(
      executeWithModelFailover(
        {
          candidates,
          task: "coding",
          policy: "free-only",
        },
        async () => {
          const error = new Error("unauthorized");
          Object.assign(error, { status: 401 });
          throw error;
        },
      ),
    ).rejects.toThrow(/1 attempt/);
  });
});
