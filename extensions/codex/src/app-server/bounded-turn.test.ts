import { describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification, JsonValue } from "./protocol.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

function modelList() {
  return {
    data: [
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
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
      cliVersion: "0.144.5",
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
  } = {},
) {
  const methods: string[] = [];
  const notificationHandlers: Array<(notification: CodexServerNotification) => void> = [];
  const request = vi.fn(async (method: string, _params?: unknown) => {
    methods.push(method);
    if (method === "model/list") {
      return modelList();
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
      return { data: options.mcpServers ?? [], nextCursor: null };
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          if (options.errorBeforeCompletion) {
            handler({
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
            handler({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                itemId: "answer",
                delta: options.assistantDelta,
              },
            });
          }
          handler({
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
                reasoningOutputTokens: 0,
              },
            },
          });
          handler({
            method: "turn/completed",
            params: {
              threadId: "thread-finalizer",
              turnId: "turn-finalizer",
              turn: {
                ...completedTurnResult().turn,
                status: options.terminalStatus ?? "completed",
                ...(options.terminalStatus === "interrupted" ? { items: [] } : {}),
              },
            },
          });
        }
      });
      return inProgressTurnResult();
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const client = {
    request,
    addNotificationHandler: vi.fn((handler) => {
      notificationHandlers.push(handler);
      return () => {
        const index = notificationHandlers.indexOf(handler);
        if (index >= 0) {
          notificationHandlers.splice(index, 1);
        }
      };
    }),
    addRequestHandler: vi.fn(() => () => undefined),
    close: vi.fn(),
  } as unknown as CodexAppServerClient;
  const factory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;
  return { factory, methods, request };
}

describe("runBoundedCodexAppServerTurn settled finalization isolation", () => {
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
        "features.hooks": false,
        "features.multi_agent": false,
        "skills.include_instructions": false,
        include_environment_context: false,
        mcp_servers: { inherited: { enabled: false } },
      },
    });
    expect(fake.request).toHaveBeenCalledWith(
      "thread/inject_items",
      { threadId: "thread-finalizer", items: historyItems },
      expect.any(Object),
    );
  });

  it("fails before history injection when the started thread exposes an MCP server", async () => {
    const fake = createClientFactory({ mcpServers: [{ name: "unexpected" }] });

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
    ).rejects.toThrow("Codex ring-zero MCP attestation found server unexpected");
    expect(fake.methods).not.toContain("thread/inject_items");
    expect(fake.methods).not.toContain("turn/start");
  });
});
