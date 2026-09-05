import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import {
  createFakeCodexAppServerClient,
  threadStartResult as createThreadStartResult,
  turnStartResult,
} from "./codex-app-server.test-fixtures.js";
import type { JsonValue } from "./protocol.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

function codexModel(model = "gpt-5.4", id = model) {
  return {
    id,
    model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: "test model",
    hidden: false,
    isDefault: true,
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

function threadStartResult(model: string, modelProvider = "openai") {
  const result = createThreadStartResult("thread-finalizer", "/tmp/finalizer");
  return {
    ...result,
    thread: { ...result.thread, sessionId: "session-finalizer", ephemeral: true, modelProvider },
    model,
    modelProvider,
    approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

function completedTurnResult() {
  return {
    turn: {
      ...turnStartResult("turn-finalizer", "completed").turn,
      items: [{ id: "answer", type: "agentMessage", text: "The message was sent successfully." }],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  };
}

function inProgressTurnResult() {
  return { turn: { ...turnStartResult("turn-finalizer").turn, startedAt: 1 } };
}

function createClientFactory(
  options: {
    mcpServers?: unknown[];
    errorBeforeCompletion?: { message: string; willRetry: boolean };
    terminalStatus?: "completed" | "interrupted";
    assistantDelta?: string;
    emptyAnswer?: boolean;
    completeTurn?: boolean;
    models?: ReturnType<typeof codexModel>[];
    beforeRequest?: (method: string) => Promise<void>;
    modelProvider?: string;
    responseCompletions?: Array<{ responseId: string; usage: JsonValue }>;
  } = {},
) {
  const methods: string[] = [];
  const fixture = createFakeCodexAppServerClient(async (method: string, params?: unknown) => {
    methods.push(method);
    if (options.beforeRequest) {
      await options.beforeRequest(method);
    }
    if (method === "model/list") {
      const includeHidden = isRecord(params) && params.includeHidden === true;
      return {
        data: (options.models ?? [codexModel()]).filter((model) => includeHidden || !model.hidden),
        nextCursor: null,
      };
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
    if (method === "thread/start" && isRecord(params) && typeof params.model === "string") {
      return threadStartResult(params.model, options.modelProvider);
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
          for (const response of options.responseCompletions ?? [
            {
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
          ]) {
            void handler({
              method: "rawResponse/completed",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                ...response,
              },
            });
          }
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
  return {
    factory,
    methods,
    request,
    notifications: fixture.notifications,
    requests: fixture.requests,
    handleServerRequest: (serverRequest: Parameters<typeof fixture.handleServerRequest>[0]) =>
      fixture.handleServerRequest(serverRequest),
    notify: (notification: Parameters<typeof fixture.notify>[0]) => fixture.notify(notification),
  };
}

describe("runBoundedCodexAppServerTurn settled finalization isolation", () => {
  it.each(["model/list", "mcpServerStatus/list"])(
    "does not dispatch a turn after its caller retires during %s",
    async (suspendedMethod) => {
      const suspended = createDeferred<void>();
      const release = createDeferred<void>();
      const fake = createClientFactory({
        beforeRequest: async (method) => {
          if (method === suspendedMethod) {
            suspended.resolve();
            await release.promise;
          }
        },
      });
      const retired = new Error("bounded turn caller retired");
      let current = true;
      const params = {
        model: { mode: "required" as const, id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "isolated completion",
        developerInstructions: "Name the conversation.",
        input: [{ type: "text" as const, text: "Help me plan a garden.", text_elements: [] }],
        requiredModalities: ["text" as const],
        isolation: "private-stdio" as const,
        requireNoExternalCapabilities: true,
        assertCurrent: () => {
          if (!current) {
            throw retired;
          }
        },
      };
      const run = runBoundedCodexAppServerTurn(params);
      const rejection = expect(run).rejects.toBe(retired);
      await suspended.promise;
      const codexHome = vi.mocked(fake.factory).mock.calls[0]?.[0]?.startOptions?.env?.CODEX_HOME;
      current = false;
      release.resolve();

      await rejection;
      expect(fake.methods).not.toContain("turn/start");
      if (suspendedMethod === "model/list") {
        expect(fake.methods).not.toContain("thread/start");
      }
      expect(fake.notifications).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
      if (!codexHome) {
        throw new Error("expected the bounded turn's temporary Codex home");
      }
      await expect(fs.access(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["thread/start", "turn/start"] as const)(
    "rejects expired authority before the physical %s write after setup",
    async (blockedMethod) => {
      let current = true;
      const expired = new Error("completion owner expired during setup");
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number; method: string };
          const results: Record<string, unknown> = {
            "model/list": { data: [codexModel()], nextCursor: null },
            "config/read": { config: {}, layers: [] },
            "configRequirements/read": { requirements: null },
            "thread/start": threadStartResult("gpt-5.4"),
            "mcpServerStatus/list": { data: [], nextCursor: null },
            "turn/start": completedTurnResult(),
          };
          if (request.method === "mcpServerStatus/list" && blockedMethod === "turn/start") {
            current = false;
          }
          send({ id: request.id, result: results[request.method] });
        },
      });
      const releaseFence = vi.fn();
      harness.client.setThreadSessionRequestGuard(async () => {
        if (blockedMethod === "thread/start") {
          current = false;
        }
        return releaseFence;
      });
      try {
        await expect(
          runBoundedCodexAppServerTurn({
            model: { mode: "required", id: "gpt-5.4" },
            timeoutMs: 5_000,
            assertCurrent: () => {
              if (!current) {
                throw expired;
              }
            },
            options: { clientFactory: async () => harness.client },
            taskLabel: "isolated completion",
            developerInstructions: "Answer only.",
            input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
            requiredModalities: ["text"],
            isolation: "configured-transport",
            requireNoExternalCapabilities: true,
          }),
        ).rejects.toBe(expired);
        expect(harness.writes.map((line) => JSON.parse(line).method)).not.toContain(blockedMethod);
        expect(releaseFence).toHaveBeenCalledOnce();
      } finally {
        harness.client.close();
      }
    },
  );

  it("returns an explicit unsupported decline for interactive MCP input", async () => {
    const fake = createClientFactory({ completeTurn: false });
    const run = runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      timeoutMs: 5_000,
      options: { clientFactory: fake.factory },
      taskLabel: "hosted search",
      developerInstructions: "Search only.",
      input: [{ type: "text", text: "Find current market news.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "private-stdio",
    });
    await vi.waitFor(() => expect(fake.methods).toContain("turn/start"));

    await expect(
      fake.handleServerRequest({
        id: "bounded-elicitation",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-finalizer",
          turnId: "turn-finalizer",
          serverName: "forms",
          mode: "form",
          message: "Enter a value",
          requestedSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      }),
    ).resolves.toEqual({
      action: "decline",
      content: null,
      _meta: { message: "OpenClaw Codex hosted search does not support interactive input." },
    });

    await fake.notify({
      method: "turn/completed",
      params: { threadId: "thread-finalizer", turn: completedTurnResult().turn },
    });
    await expect(run).resolves.toMatchObject({ text: "The message was sent successfully." });
  });

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

  it.each(["prepared", "profile", "implicit"] as const)(
    "bridges %s auth into the private home when the configured home is native",
    async (authSelection) => {
      const fake = createClientFactory();
      const preparedAuth = { kind: "api-key" as const, apiKey: "test-key" };
      const profile = "openai:bounded";

      await runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        ...(authSelection === "prepared"
          ? { preparedAuth }
          : authSelection === "profile"
            ? { profile }
            : {}),
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
          ...(authSelection === "prepared"
            ? { preparedAuth }
            : { authProfileId: authSelection === "profile" ? profile : undefined }),
          authRequirement: "api-key",
          startOptions: expect.objectContaining({
            homeScope: "agent",
            env: expect.objectContaining({
              CODEX_HOME: expect.stringContaining("codex-bounded-turn-"),
            }),
          }),
        }),
      );
      expect(vi.mocked(fake.factory).mock.calls[0]?.[0]).not.toHaveProperty(
        authSelection === "prepared" ? "authProfileId" : "preparedAuth",
      );
    },
  );

  it("carries attached provider overrides into private turns without importing tool policy", async () => {
    const fake = createClientFactory();
    await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      timeoutMs: 5_000,
      options: {
        clientFactory: fake.factory,
        pluginConfig: {
          appServer: {
            args: [
              '-copenai_base_url="http://127.0.0.1:9/first"',
              "app-server",
              '--config=openai_base_url="http://127.0.0.1:9/last"',
              '-c=model_catalog_json="/tmp/synthetic-models.json"',
              "-csandbox_workspace_write.exclude_slash_tmp=false",
              "--config",
              "features.hooks=true",
              "--",
              '-copenai_base_url="http://127.0.0.1:9/ignored"',
            ],
          },
        },
      },
      taskLabel: "isolated completion",
      developerInstructions: "Answer only.",
      input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "private-stdio",
    });
    expect(vi.mocked(fake.factory).mock.calls[0]?.[0]?.startOptions?.args).toEqual([
      "app-server",
      "-c",
      'openai_base_url="http://127.0.0.1:9/first"',
      "-c",
      'openai_base_url="http://127.0.0.1:9/last"',
      "-c",
      'model_catalog_json="/tmp/synthetic-models.json"',
      "--listen",
      "stdio://",
    ]);
    expect(
      fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
    ).toMatchObject({ sandbox: "read-only", approvalPolicy: "on-request" });
  });

  it("preserves and reports the configured native provider when no override is supplied", async () => {
    const model = "gpt-5.6-luna";
    const fake = createClientFactory({
      modelProvider: "synthetic-native-provider",
      models: [codexModel(model)],
    });

    const result = await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: model },
      timeoutMs: 5_000,
      options: {
        clientFactory: fake.factory,
        pluginConfig: { appServer: { homeScope: "user" } },
      },
      taskLabel: "isolated completion",
      developerInstructions: "Answer only.",
      input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "configured-transport",
      requireNoExternalCapabilities: true,
    });

    const startParams = fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startParams).not.toHaveProperty("modelProvider");
    expect(result.nativeSelection).toEqual({
      model,
      modelProvider: "synthetic-native-provider",
    });
    expect(fake.factory).toHaveBeenCalledWith(
      expect.objectContaining({ startOptions: expect.objectContaining({ homeScope: "user" }) }),
    );
  });

  it.each([
    { label: "visible catalog ID", id: "gpt-5.6-sol", hidden: false, requested: "gpt-5.6-sol" },
    {
      label: "hidden catalog ID",
      id: "test-hidden-catalog",
      hidden: true,
      requested: "test-hidden-catalog",
    },
    {
      label: "hidden execution ID",
      id: "test-hidden-catalog",
      hidden: true,
      requested: "codex-execution-model",
    },
  ])("uses the execution model for a required $label", async ({ id, hidden, requested }) => {
    const fake = createClientFactory({
      models: [
        { ...codexModel("codex-execution-model", id), hidden, isDefault: !hidden },
        { ...codexModel(), isDefault: hidden },
      ],
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: requested },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "isolated completion",
        developerInstructions: "Answer only.",
        input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "configured-transport",
      }),
    ).resolves.toMatchObject({
      model: id,
      nativeSelection: { model: "codex-execution-model", modelProvider: "openai" },
      text: "The message was sent successfully.",
    });

    const threadStart = fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    const turnStart = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(threadStart).toMatchObject({ model: "codex-execution-model" });
    expect(turnStart).not.toHaveProperty("model");
  });

  it("keeps hidden models out of live-default selection", async () => {
    const fake = createClientFactory({
      models: [
        { ...codexModel("test-hidden-catalog"), hidden: true, isDefault: false },
        { ...codexModel("image-only-default"), inputModalities: ["image"] },
        { ...codexModel("visible-execution-model", "visible-model"), isDefault: false },
      ],
    });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "live-default" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "hosted search",
        developerInstructions: "Search only.",
        input: [{ type: "text", text: "Find the answer.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "private-stdio",
      }),
    ).resolves.toMatchObject({
      model: "visible-model",
      nativeSelection: { model: "visible-execution-model", modelProvider: "openai" },
      text: "The message was sent successfully.",
    });

    const threadStart = fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    const turnStart = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(threadStart).toMatchObject({ model: "visible-execution-model" });
    expect(turnStart).not.toHaveProperty("model");
  });

  it("rejects a missing required model before starting a thread", async () => {
    const fake = createClientFactory();

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "missing-model" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "isolated completion",
        developerInstructions: "Answer only.",
        input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "configured-transport",
      }),
    ).rejects.toThrow("Codex app-server model not found: missing-model");
    expect(fake.methods).toEqual(["model/list"]);
  });

  it.each([false, true])(
    "attests ring-zero and totals response usage (missing final usage: %s)",
    async (missingFinalUsage) => {
      const firstResponse = {
        responseId: "response-first",
        usage: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 1,
          outputTokens: 4,
          reasoningOutputTokens: 3,
        },
      };
      const fake = createClientFactory({
        responseCompletions: [
          firstResponse,
          {
            responseId: "response-final",
            usage: {
              totalTokens: 20,
              inputTokens: 15,
              cachedInputTokens: 5,
              cacheWriteInputTokens: 2,
              outputTokens: 5,
              reasoningOutputTokens: 2,
            },
          },
          firstResponse,
          ...(missingFinalUsage ? [{ responseId: "response-without-usage", usage: null }] : []),
        ],
      });
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
          input: 13,
          output: 9,
          cacheRead: 7,
          cacheWrite: 3,
          reasoningTokens: 5,
          total: 32,
          contextUsage: missingFinalUsage
            ? { state: "unavailable" }
            : { state: "available", promptTokens: 15, totalTokens: 20 },
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
    },
  );

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
