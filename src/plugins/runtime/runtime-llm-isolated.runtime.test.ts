// Isolated runtime.llm.complete tests cover zero-tool dispatch and policy enforcement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
  runIsolatedCompletion: vi.fn(),
}));

vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: hoisted.runIsolatedCompletion,
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

function primeCompletionMocks() {
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
      const slash = params.modelRef?.indexOf("/") ?? -1;
      return {
        provider: slash > 0 ? params.modelRef?.slice(0, slash) : "openai",
        modelId: slash > 0 ? params.modelRef?.slice(slash + 1) : (params.modelRef ?? "gpt-5.5"),
        agentDir: `/tmp/${params.agentId}`,
      };
    },
  );
  hoisted.runIsolatedCompletion.mockResolvedValue({
    text: "isolated",
    provider: "openai",
    model: "gpt-5.5",
    owner: { kind: "harness", id: "openclaw" },
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
    },
  });
}

function expectSingleCallFirstArg(mock: { mock: { calls: unknown[][] } }, expected: object) {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]?.[0]).toEqual(expect.objectContaining(expected));
}

describe("runtime.llm.complete isolated agent runtime", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    hoisted.prepareSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    hoisted.runIsolatedCompletion.mockReset();
    primeCompletionMocks();
  });

  it("routes authorized isolated completion through the configured agent runtime", async () => {
    const usageEvents: Array<{
      hostPluginId?: string;
      internal?: boolean;
      trusted: boolean;
      usage: unknown;
    }> = [];
    const stop = onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
        if (event.type === "model.usage") {
          usageEvents.push({
            hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
            internal: metadata.internal,
            trusted: metadata.trusted,
            usage: event.usage,
          });
        }
      }),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.5",
      profileId: "openai:configured",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "llm-task": {
              llm: {
                allowAuthProfileOverride: true,
              },
            },
          },
        },
      }),
      authority: { allowComplete: true, preferredProfile: "openai:authority-bound" },
    });

    const result = await withPluginRuntimePluginIdScope("llm-task", () =>
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        systemPrompt: "JSON only",
        reasoning: "high",
        execution: {
          mode: "isolated-agent-runtime",
          authProfileId: "openai:work",
          timeoutMs: 12_000,
        },
      }),
    );
    stop();

    expectSingleCallFirstArg(hoisted.runIsolatedCompletion, {
      config: expect.any(Object),
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:work",
      agentId: "main",
      systemPrompt: "JSON only",
      prompt: "Return JSON",
      timeoutMs: 12_000,
      thinkLevel: "high",
      streamParams: { maxTokens: undefined, temperature: undefined },
    });
    expect(result).toMatchObject({
      text: "isolated",
      execution: {
        mode: "isolated-agent-runtime",
        owner: { kind: "harness", id: "openclaw" },
      },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      audit: { caller: { kind: "plugin", id: "llm-task" } },
    });
    expect(usageEvents).toEqual([
      {
        hostPluginId: "llm-task",
        internal: true,
        trusted: true,
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          promptTokens: 3,
          total: 5,
        },
      },
    ]);
    expect(hoisted.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("keeps usage-free isolated completions silent", async () => {
    hoisted.runIsolatedCompletion.mockResolvedValueOnce({
      text: "isolated",
      provider: "openai",
      model: "gpt-5.5",
      owner: { kind: "cli", id: "claude-cli" },
    });
    const usageEvents: unknown[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        usageEvents.push(event);
      }
    });
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    const result = await llm.complete({
      messages: [{ role: "user", content: "Return JSON" }],
      execution: { mode: "isolated-agent-runtime" },
    });
    stop();

    expect(result.usage).toEqual({});
    expect(usageEvents).toEqual([]);
  });

  it("uses the authority-bound profile before the agent-configured profile", async () => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.5",
      profileId: "openai:configured",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { allowComplete: true, preferredProfile: "openai:authority-bound" },
    });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isolated-agent-runtime" },
      }),
    ).resolves.toMatchObject({ text: "isolated" });
    expect(hoisted.runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:authority-bound" }),
    );
  });

  it("keeps an authorized model profile ahead of the authority-bound profile", async () => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.4",
      profileId: "openai:model-profile",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "model-plugin": {
              llm: {
                allowModelOverride: true,
                allowAuthProfileOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: { allowComplete: true, preferredProfile: "openai:authority-bound" },
    });

    await expect(
      withPluginRuntimePluginIdScope("model-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4@openai:model-profile",
          messages: [{ role: "user", content: "Return JSON" }],
          execution: { mode: "isolated-agent-runtime" },
        }),
      ),
    ).resolves.toMatchObject({ text: "isolated" });
    expect(hoisted.runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:model-profile" }),
    );
  });

  it("validates isolated reasoning against the host-resolved model and runtime", async () => {
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        reasoning: "ultra",
        execution: { mode: "isolated-agent-runtime" },
      }),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("denies request-level auth profiles without host policy", async () => {
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        llm.complete({
          messages: [{ role: "user", content: "Return JSON" }],
          execution: {
            mode: "isolated-agent-runtime",
            authProfileId: "openai:work",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("denies auth profiles selected through a model override without host policy", async () => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.4",
      profileId: "openai:work",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "plain-plugin": {
              llm: { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
            },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4@openai:work",
          messages: [{ role: "user", content: "Return JSON" }],
          execution: { mode: "isolated-agent-runtime" },
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("uses the agent-configured auth profile without treating it as an override", async () => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.5",
      profileId: "openai:configured",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isolated-agent-runtime" },
      }),
    ).resolves.toMatchObject({ text: "isolated" });
    expect(hoisted.runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:configured" }),
    );
  });

  it("does not require profile authority for a model-only override", async () => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.4",
      profileId: "openai:configured",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "model-plugin": {
              llm: { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
            },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("model-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Return JSON" }],
          execution: { mode: "isolated-agent-runtime" },
        }),
      ),
    ).resolves.toMatchObject({ text: "isolated" });
  });

  it("rejects chat histories before isolated runtime dispatch", async () => {
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
        execution: { mode: "isolated-agent-runtime" },
      } as unknown as Parameters<typeof llm.complete>[0]),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("rejects a missing isolated messages container with the stable input code", async () => {
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        execution: { mode: "isolated-agent-runtime" },
      } as unknown as Parameters<typeof llm.complete>[0]),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("rejects unknown execution modes instead of falling through to direct inference", async () => {
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isoltaed-agent-runtime" },
      } as unknown as Parameters<typeof llm.complete>[0]),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
    expect(hoisted.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it.each([2_147_483_648, Number.NaN])("rejects invalid isolated timeout %s", async (timeoutMs) => {
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });
    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isolated-agent-runtime", timeoutMs },
      }),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
  });

  it("settles at the deadline when the isolated runtime ignores cancellation", async () => {
    hoisted.runIsolatedCompletion.mockReturnValueOnce(new Promise(() => {}));
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isolated-agent-runtime", timeoutMs: 5 },
      }),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_TIMEOUT" });
  });

  it("settles on caller abort when the isolated runtime ignores cancellation", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    hoisted.runIsolatedCompletion.mockImplementationOnce(() => {
      markStarted?.();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });
    const completion = llm.complete({
      messages: [{ role: "user", content: "Return JSON" }],
      signal: controller.signal,
      execution: { mode: "isolated-agent-runtime" },
    });

    await started;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: "LLM_COMPLETION_ABORTED" });
  });

  it("maps unsupported isolated runtimes to a stable public error code", async () => {
    hoisted.runIsolatedCompletion.mockRejectedValueOnce(
      Object.assign(new Error("Agent harness external does not support isolated completion."), {
        code: "unsupported",
      }),
    );
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isolated-agent-runtime" },
      }),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_UNSUPPORTED" });
  });

  it.each([
    ["input-rejected", "LLM_ISOLATED_INPUT_REJECTED"],
    ["output-rejected", "LLM_COMPLETION_OUTPUT_REJECTED"],
  ] as const)("maps %s adapter failures to %s", async (adapterCode, publicCode) => {
    const usageEvents: unknown[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        usageEvents.push(event);
      }
    });
    hoisted.runIsolatedCompletion.mockRejectedValueOnce(
      Object.assign(new Error(`adapter ${adapterCode}`), { code: adapterCode }),
    );
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isolated-agent-runtime" },
      }),
    ).rejects.toMatchObject({ code: publicCode });
    stop();
    expect(usageEvents).toEqual([]);
  });
});
