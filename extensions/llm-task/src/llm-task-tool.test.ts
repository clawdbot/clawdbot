import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("typebox", () => ({
  Type: {
    Object: (schema: unknown) => schema,
    String: (schema?: unknown) => schema,
    Optional: (schema: unknown) => schema,
    Unknown: (schema?: unknown) => schema,
    Number: (schema?: unknown) => schema,
  },
}));

vi.mock("ajv", () => ({
  default: class MockAjv {
    compile(schema: unknown) {
      return (value: unknown) => {
        if (
          schema &&
          typeof schema === "object" &&
          !Array.isArray(schema) &&
          (schema as { properties?: Record<string, { type?: string }> }).properties?.foo?.type ===
            "string"
        ) {
          const ok = typeof (value as { foo?: unknown })?.foo === "string";
          (this as { errors?: Array<{ instancePath: string; message: string }> }).errors = ok
            ? undefined
            : [{ instancePath: "/foo", message: "must be string" }];
          return ok;
        }
        (this as { errors?: Array<{ instancePath: string; message: string }> }).errors = undefined;
        return true;
      };
    }

    errors?: Array<{ instancePath: string; message: string }>;
  },
}));

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => "/tmp",
  };
});

afterAll(() => {
  vi.doUnmock("typebox");
  vi.doUnmock("ajv");
  vi.doUnmock("../api.js");
  vi.resetModules();
});

import { createLlmTaskTool } from "./llm-task-tool.js";

const runEmbeddedPiAgent = vi.fn(async () => ({
  meta: { startedAt: Date.now() },
  payloads: [{ text: "{}" }],
}));

const resolveThinkingPolicy = vi.fn(() => ({
  levels: [
    { id: "off", label: "off" },
    { id: "minimal", label: "minimal" },
    { id: "low", label: "low" },
    { id: "medium", label: "medium" },
    { id: "high", label: "high" },
  ],
}));

const normalizeThinkingLevel = vi.fn((raw?: string | null) => {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "on") {
    return "low";
  }
  if (["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"].includes(value)) {
    return value;
  }
  return undefined;
});

function fakeApi(overrides: any = {}) {
  return {
    id: "llm-task",
    name: "llm-task",
    source: "test",
    config: {
      agents: { defaults: { workspace: "/tmp", model: { primary: "openai-codex/gpt-5.2" } } },
    },
    pluginConfig: {},
    runtime: {
      version: "test",
      agent: {
        defaults: { provider: "openai-codex", model: "gpt-5.2" },
        runEmbeddedPiAgent,
        resolveThinkingPolicy,
        normalizeThinkingLevel,
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  };
}

function mockEmbeddedRunJson(payload: unknown) {
  (runEmbeddedPiAgent as any).mockResolvedValueOnce({
    meta: {},
    payloads: [{ text: JSON.stringify(payload) }],
  });
}

function resetRunnerMocks() {
  runEmbeddedPiAgent.mockReset();
  runEmbeddedPiAgent.mockImplementation(async () => ({
    meta: { startedAt: Date.now() },
    payloads: [{ text: "{}" }],
  }));
  resolveThinkingPolicy.mockClear();
  normalizeThinkingLevel.mockClear();
}

async function executeEmbeddedRun(input: Record<string, unknown>) {
  const tool = createLlmTaskTool(fakeApi());
  await tool.execute("id", input);
  return (runEmbeddedPiAgent as any).mock.calls[0]?.[0];
}

describe("llm-task tool (json-only)", () => {
  beforeEach(() => {
    resetRunnerMocks();
  });

  it("returns parsed json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return foo" });
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("strips fenced json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: '```json\n{"ok":true}\n```' }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return ok" });
    expect((res as any).details.json).toEqual({ ok: true });
  });

  it("validates schema", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
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
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("throws on invalid json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "not-json" }],
    });
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x" })).rejects.toThrow(/invalid json/i);
  });

  it("throws on schema mismatch", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
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

    const call = (runEmbeddedPiAgent as any).mock.calls[0]?.[0];
    expect(call.provider).toBe("google");
    expect(call.model).toBe("gemini-3-flash-preview");
  });

  it("passes thinking override to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "high" });
    expect(call.thinkLevel).toBe("high");
    expect(resolveThinkingPolicy).toHaveBeenCalledWith({
      provider: "openai-codex",
      model: "gpt-5.2",
    });
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
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
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
      fakeApi({ pluginConfig: { allowedModels: ["openai-codex/gpt-5.2"] } }),
    );
    await expect(
      tool.execute("id", { prompt: "x", provider: "anthropic", model: "claude-4-sonnet" }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("disables tools for embedded run", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.disableTools).toBe(true);
  });
});
