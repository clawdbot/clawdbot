import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
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

const preparedModel = {
  release: vi.fn(),
  selection: {
    provider: "openai",
    modelId: "gpt-5.5",
    agentDir: "/tmp/openclaw-agent",
  },
  model: {
    provider: "openai",
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai",
    baseUrl: "https://fixture.invalid/v1",
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
} satisfies Extract<
  Awaited<ReturnType<typeof hoisted.acquireSimpleCompletionModelForAgent>>,
  { model: unknown }
>;

function captureUsageEvents() {
  const events: Array<{
    event: Extract<DiagnosticEventPayload, { type: "model.usage" }>;
    hostPluginId?: string;
    internal?: boolean;
    trusted: boolean;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent(
    markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
      if (event.type === "model.usage") {
        events.push({
          event,
          hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
          internal: metadata.internal,
          trusted: metadata.trusted,
        });
      }
    }),
  );
  return { events, stop };
}

describe("runtime.llm.complete diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(preparedModel);
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValue(preparedModel.selection);
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { total: 0.0042 },
      },
      stopReason: "stop",
    });
  });

  it("emits one trusted usage event using only host-owned plugin identity", async () => {
    const usageEvents = captureUsageEvents();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        pluginIdForPolicy: "trusted-plugin",
        allowComplete: true,
      },
    });

    const result = await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      purpose: "test-purpose",
      caller: { kind: "plugin", id: "spoofed-plugin" },
      pluginId: "spoofed-plugin",
      telemetry: { pluginId: "nested-spoofed-plugin" },
    } as Parameters<typeof llm.complete>[0] & {
      caller: unknown;
      pluginId: string;
      telemetry: { pluginId: string };
    });
    usageEvents.stop();

    expect(result.execution).toEqual({
      mode: "direct-provider",
      owner: { kind: "provider", id: "openai" },
    });
    expect(result.audit).toEqual({
      caller: { kind: "host", id: "runtime-test" },
      purpose: "test-purpose",
    });
    expect(usageEvents.events).toEqual([
      {
        trusted: true,
        hostPluginId: "trusted-plugin",
        internal: true,
        event: expect.objectContaining({
          type: "model.usage",
          agentId: "main",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 11,
            output: 7,
            cacheRead: 5,
            cacheWrite: 2,
            promptTokens: 18,
            total: 25,
          },
          costUsd: 0.0042,
        }),
      },
    ]);
  });

  it.each([
    ["absent", undefined, true, undefined, undefined],
    [
      "all-zero",
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      true,
      undefined,
      undefined,
    ],
    ["reasoning-only", { reasoningTokens: 7 }, true, undefined, undefined],
    [
      "unavailable context usage",
      { contextUsage: { state: "unavailable" } },
      true,
      undefined,
      undefined,
    ],
    [
      "input-only",
      { input: 4 },
      true,
      { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 4, total: 4 },
      undefined,
    ],
    [
      "cache-only",
      { cacheRead: 9 },
      true,
      { input: 0, output: 0, cacheRead: 9, cacheWrite: 0, promptTokens: 9, total: 9 },
      undefined,
    ],
    [
      "positive explicit cost-only",
      { cost: { total: 0.0042 } },
      true,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0, total: 0 },
      0.0042,
    ],
    ["zero explicit cost-only", { cost: { total: 0 } }, true, undefined, undefined],
    ["disabled", { input: 1 }, false, undefined, undefined],
  ] as const)(
    "emits usage only for positive enabled tokens or cost: %s",
    async (_name, rawUsage, enabled, expectedEventUsage, expectedCostUsd) => {
      hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
        content: [{ type: "text", text: "done" }],
        usage: rawUsage,
        stopReason: "stop",
      });
      const usageEvents = captureUsageEvents();
      const llm = createRuntimeLlm({
        getConfig: () => (enabled ? cfg : { ...cfg, diagnostics: { enabled: false } }),
        authority: { allowComplete: true, pluginIdForPolicy: "trusted-plugin" },
      });

      await llm.complete({ messages: [{ role: "user", content: "Ping" }] });
      usageEvents.stop();

      if (expectedEventUsage) {
        expect(usageEvents.events).toEqual([
          {
            trusted: true,
            hostPluginId: "trusted-plugin",
            internal: true,
            event: expect.objectContaining({
              usage: expectedEventUsage,
              ...(expectedCostUsd !== undefined ? { costUsd: expectedCostUsd } : {}),
            }),
          },
        ]);
      } else {
        expect(usageEvents.events).toHaveLength(0);
      }
    },
  );

  it.each([
    ["resolved provider error", "error", [{ type: "text", text: "partial" }], "partial"],
    ["resolved provider abort", "aborted", [{ type: "text", text: "partial" }], "partial"],
    ["thinking-only completion", "stop", [{ type: "thinking", thinking: "hidden" }], ""],
  ] as const)("keeps %s usage silent", async (_name, stopReason, content, expectedText) => {
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content,
      stopReason,
      usage: { input: 11, output: 7, totalTokens: 18 },
    });
    const usageEvents = captureUsageEvents();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { allowComplete: true, pluginIdForPolicy: "trusted-plugin" },
    });

    await expect(
      llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
    ).resolves.toMatchObject({ text: expectedText });
    usageEvents.stop();

    expect(usageEvents.events).toEqual([]);
  });

  it("emits no usage when the provider fails", async () => {
    const usageEvents = captureUsageEvents();
    hoisted.completeWithPreparedSimpleCompletionModel.mockRejectedValueOnce(
      new Error("provider failed"),
    );
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { allowComplete: true },
    });

    await expect(llm.complete({ messages: [{ role: "user", content: "Ping" }] })).rejects.toThrow(
      "provider failed",
    );
    usageEvents.stop();

    expect(usageEvents.events).toHaveLength(0);
  });
});
