// Runtime LLM tests cover plugin provider hooks inside the model runtime adapter.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import { runContextEngineMaintenance } from "../../agents/embedded-agent-runner/context-engine-maintenance.js";
import { buildAfterTurnRuntimeContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { RuntimeLogger } from "./types-core.js";

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

function createLogger(): RuntimeLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectSingleCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const [firstArg] = mock.mock.calls[0] ?? [];
  const record = requireRecord(firstArg, label);
  expectFields(record, expected);
  return record;
}

function expectSingleLogPayload(
  loggerMethod: MockCalls,
  message: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(loggerMethod.mock.calls).toHaveLength(1);
  const [actualMessage, payload] = loggerMethod.mock.calls[0] ?? [];
  expect(actualMessage).toBe(message);
  const payloadRecord = requireRecord(payload, "log payload");
  expectFields(payloadRecord, expected);
  return payloadRecord;
}

function primeCompletionMocks() {
  hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
      if (!params.modelRef) {
        return {
          provider: "openai",
          modelId: "gpt-5.5",
          agentDir: `/tmp/${params.agentId}`,
        };
      }
      const slash = params.modelRef.indexOf("/");
      return {
        provider: slash > 0 ? params.modelRef.slice(0, slash) : "openai",
        modelId: slash > 0 ? params.modelRef.slice(slash + 1) : params.modelRef,
        agentDir: `/tmp/${params.agentId}`,
      };
    },
  );
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    usage: {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
      total: 25,
      cost: { total: 0.0042, totalOrigin: "provider-billed" },
    },
  });
}

describe("runtime.llm.complete", () => {
  beforeEach(() => {
    hoisted.prepareSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    primeCompletionMocks();
  });

  it("binds context-engine completions to the active session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
      purpose: "memory-maintenance",
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "ada",
      allowBundledStaticCatalogFallback: true,
      allowMissingApiKeyModes: ["aws-sdk"],
      skipAgentDiscovery: true,
    });
    expect(result.agentId).toBe("ada");
    expectFields(requireRecord(result.audit, "audit"), {
      caller: { kind: "context-engine", id: "context-engine.after-turn" },
      purpose: "memory-maintenance",
      sessionKey: "agent:ada:session:abc",
    });
  });

  it("passes the active auth profile to context-engine completions", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      authProfileId: "openai:claude@martian.engineering",
      purpose: "context-engine.compaction",
    });

    await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "ada",
      preferredProfile: "openai:claude@martian.engineering",
      allowBundledStaticCatalogFallback: true,
      allowMissingApiKeyModes: ["aws-sdk"],
      skipAgentDiscovery: true,
    });
  });

  it("uses trusted context-engine attribution inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await withPluginRuntimePluginIdScope("memory-core", () =>
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
        purpose: "memory-maintenance",
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.after-turn",
    });
    expect(result.agentId).toBe("ada");
  });

  it("does not fall back to the default agent for unbound active-session hooks", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "legacy-session",
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("does not trust a fallback-derived agent in the after-turn caller", async () => {
    const attempt = {
      sessionKey: "legacy-session",
      config: cfg,
      skillsSnapshot: undefined,
      provider: "openai",
      modelId: "gpt-5.5",
      thinkLevel: "off" as const,
    } satisfies Parameters<typeof buildAfterTurnRuntimeContext>[0]["attempt"];
    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      activeAgentId: "main",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();

    const maintain = vi.fn(async (params: { runtimeContext?: typeof runtimeContext }) => {
      await params.runtimeContext?.llm?.complete({
        messages: [{ role: "user", content: "maintain" }],
      });
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    });
    const maintenanceResult = await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test" },
        maintain,
      } as never,
      sessionId: "legacy-session",
      sessionKey: "legacy-session",
      sessionFile: "legacy-session",
      reason: "turn",
      config: cfg,
      agentId: "main",
      runtimeContext,
    });

    expect(maintain).toHaveBeenCalledOnce();
    expect(maintenanceResult).toBeUndefined();
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("accepts an explicitly trusted pre-fallback agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "legacy-session",
      explicitAgentId: "ada",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });

    expect(result.agentId).toBe("ada");
  });

  it("fails closed for context-engine completions without any session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("denies context-engine model overrides without owning plugin llm policy", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("allows context-engine model overrides through the owning plugin llm policy", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4-mini", "minimax/MiniMax-M2.7"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openai/gpt-5.4-mini",
    });
    expectFields(requireRecord(result.audit, "audit"), {
      caller: { kind: "context-engine", id: "context-engine.compaction" },
      sessionKey: "agent:main:session:abc",
    });
  });

  it("denies context-engine model overrides outside the owning plugin allowlist", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted for plugin "lossless-claw"',
    );
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("matches allowlist entries for provider-qualified model ids without doubling the provider prefix", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openrouter/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("openrouter/gpt-5.4-mini"),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { agentId: string }) => ({
        provider: "openrouter",
        modelId: "openrouter/gpt-5.4-mini",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );

    await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openrouter/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openrouter/gpt-5.4-mini",
    });
  });

  it("reports denials for provider-qualified model ids without doubling the provider prefix", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openrouter/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { agentId: string }) => ({
        provider: "openrouter",
        modelId: "openrouter/gpt-5.5",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );

    let caught: unknown;
    try {
      await runtimeContext.llm!.complete({
        model: "openrouter/gpt-5.5",
        messages: [{ role: "user", content: "summarize" }],
      });
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('"openrouter/gpt-5.5"');
    expect(message).not.toContain("openrouter/openrouter/");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("keeps context-engine attribution and host-derived policy inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await withPluginRuntimePluginIdScope("spoofed-plugin", () =>
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<NonNullable<typeof runtimeContext.llm>["complete"]>[0] & {
        caller: unknown;
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.compaction",
    });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      modelRef: "openai/gpt-5.4-mini",
    });
  });

  it("allows the bound context-engine agent and denies cross-agent overrides", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "main",
      purpose: "context-engine.compaction",
    });

    await runtimeContext.llm!.complete({
      agentId: "main",
      messages: [{ role: "user", content: "summarize" }],
    });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
    });

    await expect(
      runtimeContext.llm!.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("allows explicit agentId for non-session plugin calls", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        allowAgentIdOverride: true,
        allowModelOverride: true,
        allowComplete: true,
      },
    });

    await llm.complete({
      agentId: "worker",
      messages: [{ role: "user", content: "draft" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "worker",
    });
  });

  it("ignores request auth profile preferences without a trusted authority binding", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await llm.complete({
      authProfileId: "openai:work",
      messages: [{ role: "user", content: "draft" }],
    } as Parameters<typeof llm.complete>[0] & { authProfileId: string });

    const call = expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "main",
    });
    expect(call.preferredProfile).toBeUndefined();
  });

  it("allows host model overrides only when explicit authority allowlists the model", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
        allowComplete: true,
      },
    });

    await llm.complete({
      model: "openai/gpt-5.4",
      messages: [{ role: "user", content: "Ping" }],
    });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      modelRef: "openai/gpt-5.4",
    });

    await expect(
      llm.complete({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow('model override "openai/gpt-5.5" is not allowlisted');
  });

  it("requires model overrides to satisfy host and plugin allowlists", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "restricted-plugin": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.5"],
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("restricted-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted for plugin "restricted-plugin"',
    );
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("uses runtime-scoped config and the host preparation/dispatch path", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });

    const result = await llm.complete({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Ping" },
      ],
      temperature: 0.2,
      maxTokens: 64,
      reasoning: "ultra",
      purpose: "test-purpose",
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "main",
    });
    const completionArg = expectSingleCallFirstArg(
      hoisted.completeWithPreparedSimpleCompletionModel,
      {
        cfg,
      },
    );
    const context = requireRecord(completionArg.context, "completion context");
    expect(context.systemPrompt).toBe("Be terse.");
    const [message] = requireArray(context.messages, "completion messages");
    expectFields(requireRecord(message, "completion message"), {
      role: "user",
      content: "Ping",
    });
    expectFields(requireRecord(completionArg.options, "completion options"), {
      maxTokens: 64,
      temperature: 0.2,
      reasoning: "ultra",
    });
    expectFields(requireRecord(result, "completion result"), {
      text: "done",
      provider: "openai",
      model: "gpt-5.5",
    });
    expectFields(requireRecord(result.usage, "completion usage"), {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 25,
      costUsd: 0.0042,
    });
    const logPayload = expectSingleLogPayload(
      logger.info as unknown as MockCalls,
      "plugin llm completion",
      {
        caller: { kind: "host", id: "runtime-test" },
        purpose: "test-purpose",
      },
    );
    expectFields(requireRecord(logPayload.usage, "log usage"), { costUsd: 0.0042 });
  });

  it("preserves the completion options shape when reasoning is omitted", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { allowComplete: true },
    });

    await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
    });

    const completionArg = expectSingleCallFirstArg(
      hoisted.completeWithPreparedSimpleCompletionModel,
      { cfg },
    );
    expect(requireRecord(completionArg.options, "completion options")).not.toHaveProperty(
      "reasoning",
    );
  });

  it("uses scoped plugin identity and ignores caller-shaped spoofing input", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        caller: { kind: "host", id: "ignored-host" },
        allowComplete: true,
      },
    });

    const result = await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
        purpose: "identity-test",
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<typeof llm.complete>[0] & { caller: unknown }),
    );

    expect(result.audit.caller).toEqual({ kind: "plugin", id: "trusted-plugin" });
    expectSingleLogPayload(logger.info as unknown as MockCalls, "plugin llm completion", {
      caller: { kind: "plugin", id: "trusted-plugin" },
      purpose: "identity-test",
    });
  });

  it("denies plugin model overrides by default", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("denies plugin agent overrides by default and allows them only when configured", async () => {
    const denied = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        denied.complete({
          agentId: "worker",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target agent");

    const allowed = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowAgentIdOverride: true,
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      allowed.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "worker",
    });
  });

  it("allows plugin model overrides only when configured and allowlisted", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.complete({
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openai/gpt-5.4",
    });

    await expect(
      withPluginRuntimePluginIdScope("trusted-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.6",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow('model override "openai/gpt-5.6" is not allowlisted');
  });

  it("preserves direct model-profile overrides under model authority", async () => {
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
            "trusted-plugin": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("trusted-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4@openai:work",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).resolves.toMatchObject({ text: "done" });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openai/gpt-5.4@openai:work",
    });
  });

  it("keeps the shipped model allowlist scoped to explicit overrides", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "restricted-plugin": {
              llm: { allowedModels: ["anthropic/claude-haiku-4-5"] },
            },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("restricted-plugin", () =>
        llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
      ),
    ).resolves.toMatchObject({ text: "done" });
  });

  it("applies a completion model allowlist to the host-resolved default", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "restricted-plugin": {
              llm: { allowedCompletionModels: ["anthropic/claude-haiku-4-5"] },
            },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("restricted-plugin", () =>
        llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
      ),
    ).rejects.toThrow('model "openai/gpt-5.5" is not allowlisted for completions');
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("applies the completion model allowlist to explicit overrides too", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "restricted-plugin": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["*"],
                allowedCompletionModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("restricted-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.6",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow('model "openai/gpt-5.6" is not allowlisted for completions');
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it.each([[[]], [["not-a-canonical-model-ref"]]])(
    "fails closed for an unusable completion allowlist %j",
    async (allowedCompletionModels) => {
      const llm = createRuntimeLlm({
        getConfig: () => ({
          ...cfg,
          plugins: {
            entries: {
              "restricted-plugin": { llm: { allowedCompletionModels } },
            },
          },
        }),
        authority: { allowComplete: true },
      });

      await expect(
        withPluginRuntimePluginIdScope("restricted-plugin", () =>
          llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
        ),
      ).rejects.toThrow("completion model allowlist has no valid models");
      expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    },
  );

  it("accepts an explicit wildcard completion allowlist", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "restricted-plugin": { llm: { allowedCompletionModels: ["*"] } },
          },
        },
      }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("restricted-plugin", () =>
        llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
      ),
    ).resolves.toMatchObject({ text: "done" });
  });

  it("denies completions when runtime authority disables the capability", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        allowComplete: false,
        denyReason: "not trusted",
      },
    });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow("Plugin LLM completion denied: not trusted");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expectSingleLogPayload(logger.warn as unknown as MockCalls, "plugin llm completion denied", {
      reason: "not trusted",
    });
  });
});
