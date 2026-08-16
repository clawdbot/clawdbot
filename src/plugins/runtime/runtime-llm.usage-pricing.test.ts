// Pricing provenance tests for runtime.llm.complete usage emission.
import { describe, expect, it, vi } from "vitest";
import { applyModelDefaults } from "../../config/defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: hoisted.prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function createPreparedModel(modelId = "gpt-5.5") {
  return {
    selection: {
      provider: "openai",
      modelId,
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: modelId,
      name: modelId,
      api: "openai",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} record`);
  }
  return value as Record<string, unknown>;
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], `field ${key}`).toEqual(value);
  }
}

describe("runtime.llm.complete pricing provenance", () => {
  it("omits costUsd when model pricing is unavailable", async () => {
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("unpriced-model"),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { modelRef?: string; agentId: string }) => ({
        provider: "openai",
        modelId: "unpriced-model",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      // Mirror the real adapter shape: usage always carries a cost object whose
      // totals default to zero when the provider did not bill anything.
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { allowComplete: true },
    });
    const result = await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      purpose: "test-purpose",
    });

    const usage = requireRecord(result.usage, "completion usage");
    expect(usage.costUsd).toBeUndefined();
    expectFields(usage, {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 25,
    });
  });

  it("omits costUsd for placeholder-zero pricing marked pricingUnavailable", async () => {
    const cfgWithUnknownPricing = {
      ...cfg,
      models: {
        providers: {
          codex: {
            baseUrl: "https://chatgpt.com/backend-api",
            models: [
              {
                id: "gpt-unknown",
                name: "gpt-unknown",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  pricingUnavailable: true,
                },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
    const unknownPrepared = createPreparedModel("gpt-unknown");
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue({
      ...unknownPrepared,
      selection: { ...unknownPrepared.selection, provider: "codex" },
    });
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { modelRef?: string; agentId: string }) => ({
        provider: "codex",
        modelId: "gpt-unknown",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const llm = createRuntimeLlm({
      getConfig: () => cfgWithUnknownPricing,
      authority: { allowComplete: true },
    });
    const result = await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      purpose: "test-purpose",
    });

    expect(requireRecord(result.usage, "completion usage").costUsd).toBeUndefined();
  });

  it("keeps costUsd 0 for confirmed zero-priced models", async () => {
    const cfgWithFreeModel = {
      ...cfg,
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "free-model",
                name: "free-model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("free-model"),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { modelRef?: string; agentId: string }) => ({
        provider: "openai",
        modelId: "free-model",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const llm = createRuntimeLlm({
      getConfig: () => cfgWithFreeModel,
      authority: { allowComplete: true },
    });
    const result = await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      purpose: "test-purpose",
    });

    expect(requireRecord(result.usage, "completion usage").costUsd).toBe(0);
  });

  it("omits costUsd for a configured model whose cost block is omitted", async () => {
    // The model schema permits an omitted cost block; materialization fills
    // all-zero defaults. Those defaults are unknown pricing, not a confirmed
    // $0, so the runtime completion path must omit costUsd. The cast keeps
    // the pre-materialization shape (ModelDefinitionConfig types cost as
    // required, while the zod schema and real configs allow omitting it).
    const cfgWithOmittedCost = applyModelDefaults({
      ...cfg,
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "unpriced-config-model",
                name: "unpriced-config-model",
                reasoning: false,
                input: ["text"],
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("unpriced-config-model"),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { modelRef?: string; agentId: string }) => ({
        provider: "openai",
        modelId: "unpriced-config-model",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const llm = createRuntimeLlm({
      getConfig: () => cfgWithOmittedCost,
      authority: { allowComplete: true },
    });
    const result = await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      purpose: "test-purpose",
    });

    expect(requireRecord(result.usage, "completion usage").costUsd).toBeUndefined();
  });
});
