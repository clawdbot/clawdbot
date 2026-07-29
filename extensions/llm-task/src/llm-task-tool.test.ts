// Llm Task tests cover llm task tool plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => "/tmp",
  };
});

afterAll(() => {
  vi.doUnmock("../api.js");
  vi.resetModules();
});

import { createLlmTaskTool } from "./llm-task-tool.js";

type LlmTaskApi = Parameters<typeof createLlmTaskTool>[0];
type RunEmbeddedAgent = LlmTaskApi["runtime"]["agent"]["runEmbeddedAgent"];

const runEmbeddedAgent = vi.fn<RunEmbeddedAgent>(async () => ({
  meta: { durationMs: 0, startedAt: Date.now() },
  payloads: [{ text: "{}" }],
}));

const resolveThinkingPolicy = vi.fn(
  ({ model, agentRuntime }: { model?: string | null; agentRuntime?: string | null }) => ({
    levels: [
      { id: "off", label: "off" },
      { id: "minimal", label: "minimal" },
      { id: "low", label: "low" },
      { id: "medium", label: "medium" },
      { id: "high", label: "high" },
      ...(model?.startsWith("gpt-5.6") &&
      (agentRuntime === "openclaw" || (agentRuntime === "codex" && !model.endsWith("-luna")))
        ? [
            { id: "max", label: "max" },
            { id: "ultra", label: "ultra" },
          ]
        : []),
    ],
  }),
);

const normalizeThinkingLevel = vi.fn((raw?: string | null) => {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "on") {
    return "low";
  }
  if (
    ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"].includes(value)
  ) {
    return value;
  }
  return undefined;
});

function fakeApi(overrides: Record<string, unknown> = {}): LlmTaskApi {
  return {
    id: "llm-task",
    name: "llm-task",
    source: "test",
    config: {
      agents: {
        defaults: {
          workspace: "/tmp",
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    },
    pluginConfig: {},
    runtime: {
      version: "test",
      agent: {
        defaults: { provider: "openai", model: "gpt-5.5" },
        runEmbeddedAgent,
        resolveThinkingPolicy,
        normalizeThinkingLevel,
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  } as unknown as LlmTaskApi;
}

function mockEmbeddedRunJson(payload: unknown) {
  runEmbeddedAgent.mockResolvedValueOnce({
    meta: { durationMs: 0 },
    payloads: [{ text: JSON.stringify(payload) }],
  });
}

function resetRunnerMocks() {
  runEmbeddedAgent.mockReset();
  runEmbeddedAgent.mockImplementation(async () => ({
    meta: { durationMs: 0, startedAt: Date.now() },
    payloads: [{ text: "{}" }],
  }));
  resolveThinkingPolicy.mockClear();
  normalizeThinkingLevel.mockClear();
}

async function executeEmbeddedRun(input: Record<string, unknown>) {
  const tool = createLlmTaskTool(fakeApi());
  await tool.execute("id", input);
  return firstEmbeddedRunCall();
}

function firstEmbeddedRunCall() {
  const call = runEmbeddedAgent.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected embedded agent run");
  }
  return call;
}

function resultJson(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("details" in result)) {
    throw new Error("expected tool result details");
  }
  const details = result.details;
  if (!details || typeof details !== "object" || !("json" in details)) {
    throw new Error("expected tool result JSON");
  }
  return details.json;
}

describe("llm-task tool (json-only)", () => {
  beforeEach(() => {
    resetRunnerMocks();
  });

  it("returns parsed json", async () => {
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 0 },
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return foo" });
    expect(resultJson(res)).toEqual({ foo: "bar" });
  });

  it("strips fenced json", async () => {
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 0 },
      payloads: [{ text: '```json\n{"ok":true}\n```' }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return ok" });
    expect(resultJson(res)).toEqual({ ok: true });
  });

  it("validates schema", async () => {
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 0 },
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const schema = {
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
      additionalProperties: false,
    };
    const res = await tool.execute("id", { prompt: "return foo", schema });
    expect(resultJson(res)).toEqual({ foo: "bar" });
  });

  it("validates caller schemas with repeated $id independently across calls", async () => {
    const tool = createLlmTaskTool(fakeApi());
    runEmbeddedAgent
      .mockResolvedValueOnce({
        meta: { durationMs: 0 },
        payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
      })
      .mockResolvedValueOnce({
        meta: { durationMs: 0 },
        payloads: [{ text: JSON.stringify({ count: 1 }) }],
      });

    await expect(
      tool.execute("id", {
        prompt: "return foo",
        schema: {
          $id: "https://example.test/llm-task-result",
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
          additionalProperties: false,
        },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{\n  "foo": "bar"\n}' }],
      details: { json: { foo: "bar" }, provider: "openai", model: "gpt-5.5" },
    });

    await expect(
      tool.execute("id", {
        prompt: "return count",
        schema: {
          $id: "https://example.test/llm-task-result",
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{\n  "count": 1\n}' }],
      details: { json: { count: 1 }, provider: "openai", model: "gpt-5.5" },
    });
  });

  it("throws on invalid json", async () => {
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 0 },
      payloads: [{ text: "not-json" }],
    });
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x" })).rejects.toThrow(/invalid json/i);
  });

  it("throws on schema mismatch", async () => {
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 0 },
      payloads: [{ text: JSON.stringify({ foo: 1 }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
    await expect(tool.execute("id", { prompt: "x", schema })).rejects.toThrow(/match schema/i);
  });

  it("passes provider/model overrides to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({
      prompt: "x",
      provider: "anthropic",
      model: "claude-4-sonnet",
    });
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-4-sonnet");
  });

  it("accepts model overrides that already include the selected provider prefix", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({
      prompt: "x",
      provider: "anthropic",
      model: "anthropic/claude-4-sonnet",
    });
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-4-sonnet");
  });

  it("resolves configured model aliases before dispatching the embedded run", async () => {
    mockEmbeddedRunJson({ ok: true });
    const tool = createLlmTaskTool(
      fakeApi({
        config: {
          agents: {
            defaults: {
              workspace: "/tmp",
              model: { primary: "anthropic/claude-sonnet-4-6" },
              models: {
                "google/gemini-3-flash-preview": { alias: "gemini-flash" },
              },
            },
          },
        },
      }),
    );

    await tool.execute("id", { prompt: "x", model: "gemini-flash" });

    const call = firstEmbeddedRunCall();
    expect(call.provider).toBe("google");
    expect(call.model).toBe("gemini-3-flash-preview");
  });

  it("passes thinking override to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "high" });
    expect(call.thinkLevel).toBe("high");
    expect(resolveThinkingPolicy).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.5",
      agentRuntime: "openclaw",
    });
  });

  it("lets a configured Codex runtime own Ultra validation and execution", async () => {
    mockEmbeddedRunJson({ ok: true });
    const config = {
      agents: {
        defaults: {
          workspace: "/tmp",
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const tool = createLlmTaskTool(fakeApi({ config }));

    await tool.execute("id", {
      prompt: "x",
      provider: "openai",
      model: "gpt-5.6-sol",
      thinking: "ultra",
    });

    expect(resolveThinkingPolicy).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.6-sol",
      agentRuntime: "codex",
    });
    const call = firstEmbeddedRunCall();
    expect(call.thinkLevel).toBe("ultra");
    expect(call.config).toBe(config);
    expect(call.agentHarnessRuntimeOverride).toBe("codex");
  });

  it("lets an explicit OpenClaw model runtime own Luna Ultra", async () => {
    mockEmbeddedRunJson({ ok: true });
    const config = {
      agents: {
        defaults: {
          workspace: "/tmp",
          model: { primary: "openai/gpt-5.6-luna" },
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    };
    const tool = createLlmTaskTool(fakeApi({ config }));

    await tool.execute("id", {
      prompt: "x",
      provider: "openai",
      model: "gpt-5.6-luna",
      thinking: "ultra",
    });

    expect(resolveThinkingPolicy).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: "openclaw",
    });
    const call = firstEmbeddedRunCall();
    expect(call.thinkLevel).toBe("ultra");
    expect(call.config).toBe(config);
    expect(call.agentHarnessRuntimeOverride).toBe("openclaw");
  });

  it("normalizes thinking aliases", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "on" });
    expect(call.thinkLevel).toBe("low");
  });

  it("throws on invalid thinking level", async () => {
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x", thinking: "banana" })).rejects.toThrow(
      /invalid thinking level/i,
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("throws on unsupported xhigh thinking level", async () => {
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x", thinking: "xhigh" })).rejects.toThrow(
      /not supported/i,
    );
  });

  it("does not pass thinkLevel when thinking is omitted", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.thinkLevel).toBeUndefined();
  });

  it("enforces allowedModels", async () => {
    mockEmbeddedRunJson({ ok: true });
    const tool = createLlmTaskTool(
      fakeApi({ pluginConfig: { allowedModels: ["openai/gpt-5.5"] } }),
    );
    await expect(
      tool.execute("id", { prompt: "x", provider: "anthropic", model: "claude-4-sonnet" }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("disables tools for embedded run", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.disableTools).toBe(true);
    expect(call.agentHarnessRuntimeOverride).toBe("openclaw");
  });

  it("rejects malformed numeric run options before dispatch", async () => {
    const tool = createLlmTaskTool(fakeApi());

    await expect(tool.execute("id", { prompt: "x", temperature: Number.NaN })).rejects.toThrow(
      "temperature must be a finite number",
    );
    await expect(tool.execute("id", { prompt: "x", maxTokens: 0 })).rejects.toThrow(
      "maxTokens must be a positive integer",
    );
    await expect(tool.execute("id", { prompt: "x", timeoutMs: "4096.5" })).rejects.toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("passes valid numeric run options before dispatch", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({
      prompt: "x",
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 10_000,
    });

    expect(call.timeoutMs).toBe(10_000);
    expect(call.streamParams).toEqual({
      temperature: 0.2,
      maxTokens: 512,
    });
  });

  it("normalizes numeric string run options before dispatch", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({
      prompt: "x",
      temperature: "0.2",
      maxTokens: "512",
      timeoutMs: "10000",
    });

    expect(call.timeoutMs).toBe(10_000);
    expect(call.streamParams).toEqual({
      temperature: 0.2,
      maxTokens: 512,
    });
  });
});
