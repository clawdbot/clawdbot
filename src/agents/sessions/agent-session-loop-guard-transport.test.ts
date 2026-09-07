import { mkdtemp, rm } from "node:fs/promises";
// Real-behavior proof for #120962: drives a real AgentSession through the real
// openai-responses HTTP transport against a local SSE upstream (transport-level
// requests are real; only the upstream model is simulated). The upstream
// "decides" to re-issue the identical query_mam_status call every turn (the
// 429-hidden-in-success disease), and the maxIdleRepeatCalls guard must
// terminate the run after 3 provider round trips with no 4th HTTP request.
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "../../llm/types.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult, ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempRoots: string[] = [];
// Preserve any ambient provider key so this file's placeholder never leaks:
// a later test in the same worker must see the same env it started with.
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
beforeEach(() => {
  // The local SSE upstream ignores auth; a placeholder key satisfies the
  // transport's provider-key gate so the request actually reaches baseUrl.
  process.env.OPENAI_API_KEY = "sk-fake-local";
});
afterEach(() => {
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
});
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createEmptyResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function mamToolCallEvents() {
  const name = "query_mam_status";
  const args = { service: "mam", region: "us-east-1" };
  const serialized = JSON.stringify(args);
  const callId = "call_live_mam";
  const itemId = "fc_live_mam";
  const item = { type: "function_call", id: itemId, call_id: callId, name, arguments: serialized };
  return [
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: itemId, call_id: callId, name, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", delta: serialized },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: "resp_live_mam",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

async function startFakeResponsesServer(): Promise<{
  server: Server;
  port: number;
  getRequestCount: () => number;
}> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    let bodyText = "";
    req.on("data", (chunk) => {
      bodyText += String(chunk);
    });
    req.on("end", () => {
      requestCount += 1;
      void bodyText;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const event of mamToolCallEvents()) {
        res.write("data: " + JSON.stringify(event) + "\n\n");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port, getRequestCount: () => requestCount };
}

describe("agent session loop guards over the real transport", () => {
  it("maxIdleRepeatCalls terminates the run after 3 real transport round trips", async () => {
    const { server, port, getRequestCount } = await startFakeResponsesServer();
    const root = await mkdtemp(path.join(tmpdir(), "loop-guard-live-trace-"));
    tempRoots.push(root);
    const cwd = path.join(root, "cwd");
    const agentDir = path.join(root, "agent");
    await mkdtemp(cwd);
    await mkdtemp(agentDir);
    const model: Model = {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna (local fake upstream)",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "http://127.0.0.1:" + port,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000,
      maxTokens: 10000,
    };
    const mamTool: ToolDefinition = {
      name: "query_mam_status",
      label: "Query MAM status",
      description: "Queries the MAM (model activity monitor) service status.",
      parameters: Type.Object({
        service: Type.String(),
        region: Type.String(),
      }),
      execute: async () => ({
        content: [
          {
            type: "text",
            text: 'HTTP 200 OK (body: {"429":"rate_limited","retry_after":60})',
          },
        ],
        details: {},
      }),
    };

    const authStorage = AuthStorage.inMemory({});
    const trace: string[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        authStorage,
        modelRegistry: ModelRegistry.inMemory(authStorage),
        resourceLoader: createEmptyResourceLoader(),
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        customTools: [mamTool],
        // Runtime-resolved guard state: the configured values a native owner
        // path gets from resolveLoopGuardRuntimeConfig when guard keys are
        // explicitly set in tools.loopDetection.
        loopGuardConfig: {
          maxTurns: 200,
          maxConsecutiveErrorBatches: 3,
          maxIdleRepeatCalls: 3,
        },
      }));
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          const message = event.message as AssistantMessage;
          const text = (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          trace.push(
            "[assistant] stopReason=" + message.stopReason + " text=" + JSON.stringify(text),
          );
          for (const part of message.content ?? []) {
            if (part.type === "toolCall") {
              trace.push("[tool-call] " + part.name + "(" + JSON.stringify(part.arguments) + ")");
            }
          }
        } else if (event.type === "tool_execution_end") {
          trace.push("[tool] " + event.toolName + " -> " + JSON.stringify(event.result));
        }
      });

      await session.agent.prompt({
        role: "user",
        content: [{ type: "text", text: "Check the MAM service status." }],
        timestamp: Date.now(),
      });
      await session.agent.waitForIdle();
    } finally {
      session?.dispose();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    const requestCount = getRequestCount();

    const transcript = session.agent.state.messages;
    const finalAssistant = [...transcript].toReversed().find((m) => m.role === "assistant");

    // The trace is the real-behavior proof: three real transport round trips
    // (HTTP /v1/responses against the local SSE upstream), three identical
    // tool executions whose success-shaped output hides the upstream 429, and
    // then the idle-repeat guard terminating the run with no 4th request.
    const toolLines = trace.filter((line) => line.startsWith("[tool] query_mam_status"));
    expect(requestCount).toBe(3);
    expect(toolLines).toHaveLength(3);
    for (const line of toolLines) {
      expect(line).toContain("rate_limited");
    }
    expect(trace.at(-1)).toBe(
      '[assistant] stopReason=stop text="OpenClaw stopped this run because the same tool was called with identical arguments 3 times in a row without progress (maxIdleRepeatCalls)."',
    );
    expect(finalAssistant?.stopReason).toBe("stop");
    expect(
      JSON.stringify(transcript).includes(
        "same tool was called with identical arguments 3 times in a row",
      ),
    ).toBe(true);
  }, 120_000);
});
