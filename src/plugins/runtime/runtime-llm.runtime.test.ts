import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/pi-embedded-runner/context-engine-capabilities.js";
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(typeof value, label).toBe("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

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
      cost: { total: 0.0042 },
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
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    expect(result.agentId).toBe("ada");
    expectFields(requireRecord(result.audit, "audit"), {
      caller: { kind: "context-engine", id: "context-engine.after-turn" },
      purpose: "memory-maintenance",
      sessionKey: "agent:ada:session:abc",
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
        model: "openai-codex/gpt-5.4-mini",
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
                allowedModels: ["openai-codex/gpt-5.4-mini", "minimax/MiniMax-M2.7"],
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
      model: "openai-codex/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openai-codex/gpt-5.4-mini",
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
                allowedModels: ["openai-codex/gpt-5.4-mini"],
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
        model: "openai-codex/gpt-5.5",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow(
      'model override "openai-codex/gpt-5.5" is not allowlisted for plugin "lossless-claw"',
    );
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
                allowedModels: ["openai-codex/gpt-5.4-mini"],
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
        model: "openai-codex/gpt-5.4-mini",
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
      modelRef: "openai-codex/gpt-5.4-mini",
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
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow('model override "openai/gpt-5.5" is not allowlisted');
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
