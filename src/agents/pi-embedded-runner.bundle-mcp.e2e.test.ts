import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import {
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  type EmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

const E2E_TIMEOUT_MS = 40_000;

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

let streamCallCount = 0;
let observedContexts: Array<Array<{ role?: string; content?: unknown }>> = [];

vi.mock("./pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: vi.fn(async () => true),
  getOrCreateSessionMcpRuntime: async () => ({
    sessionId: "bundle-mcp-runtime",
    sessionKey: "agent:test:bundle-mcp-e2e",
    workspaceDir: "/tmp",
    configFingerprint: "test",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: Date.now(),
      servers: {},
      tools: [],
    }),
    callTool: async () => ({
      content: [{ type: "text", text: "FROM-BUNDLE" }],
    }),
    dispose: async () => {},
  }),
  materializeBundleMcpToolsForRun: async () => {
    const tool = {
      name: "bundleProbe__bundle_probe",
      label: "bundle_probe",
      description: "Bundle MCP probe",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text", text: "FROM-BUNDLE" }],
        details: {
          mcpServer: "bundleProbe",
          mcpTool: "bundle_probe",
        },
      }),
    };
    setPluginToolMeta(tool as any, { pluginId: "bundle-mcp", optional: false });
    return {
      tools: [tool],
      dispose: async () => {},
    };
  },
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildToolUseMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id: "tc-bundle-mcp-1",
        name: "bundleProbe__bundle_probe",
        arguments: {},
      },
    ],
    stopReason: "toolUse" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildStopMessage = (
    model: { api: string; provider: string; id: string },
    text: string,
  ) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount += 1;
      return streamCallCount === 1
        ? buildToolUseMessage(model)
        : buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE");
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount += 1;
      return streamCallCount === 1
        ? buildToolUseMessage(model)
        : buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE");
    },
    streamSimple: (
      model: { api: string; provider: string; id: string },
      context: { messages?: Array<{ role?: string; content?: unknown }> },
    ) => {
      streamCallCount += 1;
      const messages = (context.messages ?? []).map((message) => Object.assign({}, message));
      observedContexts.push(messages);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (streamCallCount === 1) {
          stream.push({
            type: "done",
            reason: "toolUse",
            message: buildToolUseMessage(model),
          });
          stream.end();
          return;
        }

        const toolResultText = messages.flatMap((message) =>
          Array.isArray(message.content)
            ? (message.content as Array<{ type?: string; text?: string }>)
                .filter((entry) => entry.type === "text" && typeof entry.text === "string")
                .map((entry) => entry.text ?? "")
            : [],
        );
        const sawBundleResult = toolResultText.some((text) => text.includes("FROM-BUNDLE"));
        if (!sawBundleResult) {
          stream.push({
            type: "done",
            reason: "stop",
            message: buildStopMessage(model, "bundle MCP tool result missing from context"),
          });
          stream.end();
          return;
        }

        stream.push({
          type: "done",
          reason: "stop",
          message: buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE"),
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-bundle-mcp-pi-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

const readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message) as Array<{ role?: string; content?: unknown }>;
};

describe("runEmbeddedPiAgent bundle MCP e2e", () => {
  it.skip(
    "loads bundle MCP into Pi, executes the MCP tool, and includes the result in the follow-up turn",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      streamCallCount = 0;
      observedContexts = [];

      const sessionFile = path.join(workspaceDir, "session-bundle-mcp-e2e.jsonl");
      const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-bundle-mcp"]);

      const result = await runEmbeddedPiAgent({
        sessionId: "bundle-mcp-e2e",
        sessionKey: "agent:test:bundle-mcp-e2e",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "Use the bundle MCP tool and report its result.",
        provider: "openai",
        model: "mock-bundle-mcp",
        timeoutMs: 30_000,
        agentDir,
        runId: "run-bundle-mcp-e2e",
        enqueue: immediateEnqueue,
      });

      expect(result.payloads?.[0]?.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
      expect(streamCallCount).toBe(2);

      const followUpContext = observedContexts[1] ?? [];
      const followUpTexts = followUpContext.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; text?: string }>)
              .filter((entry) => entry.type === "text" && typeof entry.text === "string")
              .map((entry) => entry.text ?? "")
          : [],
      );
      expect(followUpTexts.some((text) => text.includes("FROM-BUNDLE"))).toBe(true);

      const messages = await readSessionMessages(sessionFile);
      const toolResults = messages.filter((message) => message?.role === "toolResult");
      const toolResultText = toolResults.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; text?: string }>)
              .filter((entry) => entry.type === "text" && typeof entry.text === "string")
              .map((entry) => entry.text ?? "")
          : [],
      );
      expect(toolResultText.some((text) => text.includes("FROM-BUNDLE"))).toBe(true);
    },
  );
});
