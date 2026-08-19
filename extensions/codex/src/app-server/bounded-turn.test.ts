import { describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import type { JsonValue } from "./protocol.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

function modelList(model = "gpt-5.4", id = model) {
  return {
    data: [
      {
        id,
        model,
        displayName: "GPT-5.4",
        description: "test model",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "low",
        supportsPersonality: false,
        additionalSpeedTiers: [],
      },
    ],
    nextCursor: null,
  };
}

function threadStartResult() {
  return {
    thread: {
      id: "thread-finalizer",
      sessionId: "session-finalizer",
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      cwd: "/tmp/finalizer",
      cliVersion: CODEX_APP_SERVER_VERSION,
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    cwd: "/tmp/finalizer",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

function completedTurnResult() {
  return {
    turn: {
      id: "turn-finalizer",
      status: "completed",
      items: [
        {
          id: "answer",
          type: "agentMessage",
          text: "The message was sent successfully.",
          title: null,
          status: "completed",
          name: null,
          tool: null,
          server: null,
          command: null,
          cwd: null,
          query: null,
          aggregatedOutput: null,
          changes: [],
        },
      ],
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  };
}

function inProgressTurnResult() {
  return {
    turn: {
      id: "turn-finalizer",
      status: "inProgress",
      items: [],
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createClientFactory(
  options: {
    mcpServers?: unknown[];
    errorBeforeCompletion?: { message: string; willRetry: boolean };
    terminalStatus?: "completed" | "interrupted";
    assistantDelta?: string;
    emptyAnswer?: boolean;
    completeTurn?: boolean;
    model?: string;
    modelId?: string;
  } = {},
) {
  const methods: string[] = [];
  const fixture = createFakeCodexAppServerClient(async (method: string, _params?: unknown) => {
    methods.push(method);
    if (method === "model/list") {
      return modelList(options.model, options.modelId);
    }
    if (method === "config/read") {
      return {
        config: { mcp_servers: { inherited: { command: "unsafe" } } },
        layers: [{ name: { type: "user" } }],
      };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: options.mcpServers ?? [
          {
            name: "inherited",
            serverInfo: null,
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => {
        for (const handler of fixture.notifications) {
          void handler({
            method: "turn/completed",
            params: {
              threadId: "thread-finalizer",
              turn: { ...inProgressTurnResult().turn, status: "interrupted" },
            },
          });
        }
      });
      return {};
    }
    if (method === "turn/start") {
      if (options.completeTurn === false) {
        return inProgressTurnResult();
      }
      queueMicrotask(() => {
        for (const handler of fixture.notifications) {
          if (options.errorBeforeCompletion) {
            void handler({
              method: "error",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                error: { message: options.errorBeforeCompletion.message },
                willRetry: options.errorBeforeCompletion.willRetry,
              },
            });
          }
          if (options.assistantDelta) {
            void handler({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                itemId: "answer",
                delta: options.assistantDelta,
              },
            });
          }
          void handler({
            method: "rawResponse/completed",
            params: {
              threadId: "thread-finalizer",
              turnId: "turn-finalizer",
              responseId: "response-finalizer",
              usage: {
                totalTokens: 12,
                inputTokens: 8,
                cachedInputTokens: 2,
                cacheWriteInputTokens: 1,
                outputTokens: 4,
                reasoningOutputTokens: 3,
              },
            },
          });
          void handler({
            method: "turn/completed",
            params: {
              threadId: "thread-finalizer",
              turnId: "turn-finalizer",
              turn: {
                ...completedTurnResult().turn,
                status: options.terminalStatus ?? "completed",
                ...(options.terminalStatus === "interrupted" || options.emptyAnswer
                  ? { items: [] }
                  : {}),
              },
            },
          });
        }
      });
      return inProgressTurnResult();
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const request = fixture.request;
  const client = Object.assign(fixture.client, { close: vi.fn() });
  const factory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;
  return { factory, methods, request };
}

describe("runBoundedCodexAppServerTurn settled finalization isolation", () => {
  it("reports its own timeout with the configured bound", async () => {
    const fake = createClientFactory({ completeTurn: false });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 100,
        options: { clientFactory: fake.factory },
        taskLabel: "hosted search",
        developerInstructions: "Search only.",
        input: [{ type: "text", text: "Find current market news.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
      }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "codex app-server hosted search turn timed out after 100ms",
    });
  });

  it("keeps a caller abort distinct from its own timeout", async () => {
    const fake = createClientFactory({ completeTurn: false });
    const caller = new AbortController();
    const reason = new Error("caller cancelled hosted search");
    caller.abort(reason);

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        signal: caller.signal,
        options: { clientFactory: fake.factory },
        taskLabel: "hosted search",
        developerInstructions: "Search only.",
        input: [{ type: "text", text: "Find current market news.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
      }),
    ).rejects.toMatchObject({
      name: "Error",
      message: "codex app-server hosted search turn aborted",
    });
  });

  it("does not adopt a prior turn's timeout as its own", async () => {
    const first = createClientFactory({ completeTurn: false });
    let priorTimeout: unknown;
    try {
      await runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 100,
        options: { clientFactory: first.factory },
        taskLabel: "first hosted search",
        developerInstructions: "Search only.",
        input: [{ type: "text", text: "Find first query.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
      });
    } catch (error) {
      priorTimeout = error;
    }
    expect(priorTimeout).toMatchObject({ name: "TimeoutError" });

    const caller = new AbortController();
    caller.abort(priorTimeout);
    const second = createClientFactory({ completeTurn: false });
    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        signal: caller.signal,
        options: { clientFactory: second.factory },
        taskLabel: "second hosted search",
        developerInstructions: "Search only.",
        input: [{ type: "text", text: "Find second query.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
      }),
    ).rejects.toMatchObject({
      name: "Error",
      message: "codex app-server second hosted search turn aborted",
    });
  });

  it("continues after a retryable error notification", async () => {
    const fake = createClientFactory({
      errorBeforeCompletion: { message: "temporary upstream disconnect", willRetry: true },
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "settled-turn finalization",
        developerInstructions: "Finalize only.",
        input: [{ type: "text", text: "Produce the final answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
      }),
    ).resolves.toMatchObject({ text: "The message was sent successfully." });
  });

  it("can return a completed turn without text when the finalization caller opts in", async () => {
    const fake = createClientFactory({ emptyAnswer: true });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "settled-turn finalization",
        developerInstructions: "Finalize only.",
        input: [{ type: "text", text: "Produce the final answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
        allowEmptyText: true,
      }),
    ).resolves.toMatchObject({ text: "", model: "gpt-5.4" });
  });

  it("rejects a completed turn without text for ordinary bounded callers", async () => {
    const fake = createClientFactory({ emptyAnswer: true });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "hosted search",
        developerInstructions: "Search only.",
        input: [{ type: "text", text: "Find the answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
      }),
    ).rejects.toThrow("hosted search turn returned no text");

    const startParams = fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startParams).toMatchObject({ config: { project_doc_max_bytes: 131_072 } });
  });

  it("still fails on a terminal error notification", async () => {
    const fake = createClientFactory({
      errorBeforeCompletion: { message: "terminal upstream failure", willRetry: false },
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "settled-turn finalization",
        developerInstructions: "Finalize only.",
        input: [{ type: "text", text: "Produce the final answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
      }),
    ).rejects.toThrow("terminal upstream failure");
  });

  it("rejects an interrupted turn even when it emitted partial assistant text", async () => {
    const fake = createClientFactory({
      terminalStatus: "interrupted",
      assistantDelta: "Partial answer that must not be delivered.",
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "settled-turn finalization",
        developerInstructions: "Finalize only.",
        input: [{ type: "text", text: "Produce the final answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
      }),
    ).rejects.toThrow("turn ended with status interrupted");
  });

  it("forwards one prepared authorization selection to the isolated client", async () => {
    const fake = createClientFactory();
    const preparedAuth = { kind: "api-key" as const, apiKey: "test-key" };

    await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      preparedAuth,
      authRequirement: "api-key",
      timeoutMs: 5_000,
      options: {
        clientFactory: fake.factory,
        pluginConfig: { appServer: { homeScope: "user" } },
      },
      taskLabel: "isolated completion",
      developerInstructions: "Answer only.",
      input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "private-stdio",
      requireNoExternalCapabilities: true,
    });

    expect(fake.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuth,
        authRequirement: "api-key",
        startOptions: expect.objectContaining({ homeScope: "agent" }),
      }),
    );
    expect(vi.mocked(fake.factory).mock.calls[0]?.[0]).not.toHaveProperty("authProfileId");
  });

  it("preserves the configured native model provider when no override is supplied", async () => {
    const fake = createClientFactory();

    await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      timeoutMs: 5_000,
      options: { clientFactory: fake.factory },
      taskLabel: "isolated completion",
      developerInstructions: "Answer only.",
      input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "configured-transport",
      requireNoExternalCapabilities: true,
    });

    const startParams = fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startParams).not.toHaveProperty("modelProvider");
  });

  it("uses the execution model for required logical model ids", async () => {
    const fake = createClientFactory({
      model: "codex-execution-model",
      modelId: "gpt-5.6-sol",
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.6-sol" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "isolated completion",
        developerInstructions: "Answer only.",
        input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "configured-transport",
      }),
    ).resolves.toMatchObject({ model: "gpt-5.6-sol" });

    const threadStart = fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    const turnStart = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(threadStart).toMatchObject({ model: "codex-execution-model" });
    expect(turnStart).toMatchObject({ model: "codex-execution-model" });
  });

  it("attests ring-zero and injects frozen history before starting the final turn", async () => {
    const fake = createClientFactory();
    const historyItems: JsonValue[] = [
      { type: "function_call", call_id: "call-1", name: "message", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "sent" },
    ];

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "settled-turn finalization",
        developerInstructions: "Finalize only.",
        input: [{ type: "text", text: "Produce the final answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
        historyItems,
        requireNoExternalCapabilities: true,
      }),
    ).resolves.toMatchObject({
      text: "The message was sent successfully.",
      model: "gpt-5.4",
      usage: {
        input: 5,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        reasoningTokens: 3,
        total: 12,
      },
    });

    expect(fake.methods).toEqual([
      "model/list",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
      "thread/inject_items",
      "turn/start",
    ]);
    const startParams = fake.request.mock.calls.find(
      ([method]) => method === "thread/start",
    )?.[1] as Record<string, unknown> | undefined;
    expect(startParams).toMatchObject({
      baseInstructions: "",
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      config: {
        "agents.enabled": false,
        "features.hooks": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.code_mode": false,
        "features.code_mode_only": false,
        "skills.include_instructions": false,
        include_environment_context: false,
        mcp_servers: { inherited: { enabled: false } },
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
      },
    });
    const turnParams = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(turnParams).not.toHaveProperty("cwd");
    expect(turnParams).not.toHaveProperty("environments");
    expect(fake.request).toHaveBeenCalledWith(
      "thread/inject_items",
      { threadId: "thread-finalizer", items: historyItems },
      expect.any(Object),
    );
  });

  it("fails before history injection when the started thread exposes an MCP server", async () => {
    const fake = createClientFactory({
      mcpServers: [{ name: "unexpected", serverInfo: null, tools: {} }],
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "settled-turn finalization",
        developerInstructions: "Finalize only.",
        input: [{ type: "text", text: "Produce the final answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
        historyItems: [{ type: "function_call_output", call_id: "call-1", output: "sent" }],
        requireNoExternalCapabilities: true,
      }),
    ).rejects.toThrow(
      "Codex restricted-tool-surface MCP attestation found unexpected server unexpected",
    );
    expect(fake.methods).not.toContain("thread/inject_items");
    expect(fake.methods).not.toContain("turn/start");
  });
});
