// Codex tests cover side question plugin behavior.
import {
  nativeHookRelayTesting,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexServerNotification, JsonObject, JsonValue, RpcRequest } from "./protocol.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

const readCodexAppServerBindingMock = vi.fn();
const isCodexAppServerNativeAuthProfileMock = vi.fn();
const getSharedCodexAppServerClientMock = vi.fn();
const refreshCodexAppServerAuthTokensMock = vi.fn();
const createOpenClawCodingToolsMock = vi.fn();
const toolExecuteMock = vi.fn();
const handleCodexAppServerApprovalRequestMock = vi.fn();
const resolveCodexProviderWebSearchSupportForClientMock = vi.fn();
type SelectionRetryParams = {
  lease: { client?: unknown };
  options: { timeoutMs?: number; abandonSignal?: AbortSignal };
  run: (
    client: unknown,
    requestOptions: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<unknown>;
  onClientChange: (client: unknown) => void;
};
const withLeasedCodexAppServerClientStartSelectionRetryMock = vi.fn(
  async (params: SelectionRetryParams) =>
    await params.run(params.lease.client, {
      timeoutMs: params.options.timeoutMs ?? 60_000,
      signal: params.options.abandonSignal,
    }),
);

function supervisionConnectionFingerprint(): string {
  return buildCodexAppServerConnectionFingerprint(
    resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: { supervision: { enabled: true } },
    }),
  );
}

vi.mock("./session-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-binding.js")>()),
  isCodexAppServerNativeAuthProfile: (...args: unknown[]) =>
    isCodexAppServerNativeAuthProfileMock(...args),
}));

vi.mock("./shared-client.js", () => ({
  getSharedCodexAppServerClient: (...args: unknown[]) => getSharedCodexAppServerClientMock(...args),
  getLeasedSharedCodexAppServerClient: (...args: unknown[]) =>
    getSharedCodexAppServerClientMock(...args),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withLeasedCodexAppServerClientStartSelectionRetry: (params: SelectionRetryParams) =>
    withLeasedCodexAppServerClientStartSelectionRetryMock(params),
}));

vi.mock("./auth-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-bridge.js")>()),
  refreshCodexAppServerAuthTokens: (...args: unknown[]) =>
    refreshCodexAppServerAuthTokensMock(...args),
}));

vi.mock("./approval-bridge.js", () => ({
  handleCodexAppServerApprovalRequest: (...args: unknown[]) =>
    handleCodexAppServerApprovalRequestMock(...args),
}));

vi.mock("./provider-capabilities.js", () => ({
  resolveCodexProviderWebSearchSupportForClient: (...args: unknown[]) =>
    resolveCodexProviderWebSearchSupportForClientMock(...args),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: (...args: unknown[]) => createOpenClawCodingToolsMock(...args),
}));

const { runCodexAppServerSideQuestion: runCodexAppServerSideQuestionImpl } =
  await import("./side-question.js");
const baseBindingStore = createCodexTestBindingStore();
const bindingStore: CodexAppServerBindingStore = {
  ...baseBindingStore,
  read: async (...args) => await readCodexAppServerBindingMock(...args),
};

function runCodexAppServerSideQuestion(
  params: Parameters<typeof runCodexAppServerSideQuestionImpl>[0],
  options: Omit<Parameters<typeof runCodexAppServerSideQuestionImpl>[1], "bindingStore"> = {},
) {
  return runCodexAppServerSideQuestionImpl(params, { ...options, bindingStore });
}

type ServerRequest = Required<Pick<RpcRequest, "id" | "method">> & {
  params?: RpcRequest["params"];
};
type ClientRequest = (
  method: string,
  requestParams?: unknown,
  options?: unknown,
) => Promise<unknown>;

type FakeClient = {
  request: ReturnType<typeof vi.fn<ClientRequest>>;
  addNotificationHandler: ReturnType<typeof vi.fn>;
  addRequestHandler: ReturnType<typeof vi.fn>;
  notifications: Array<(notification: CodexServerNotification) => void>;
  requests: Array<(request: ServerRequest) => unknown>;
  emit: (notification: CodexServerNotification) => void;
  handleRequest: (request: ServerRequest) => Promise<unknown>;
};

function createFakeClient(): FakeClient {
  const notifications: FakeClient["notifications"] = [];
  const requests: FakeClient["requests"] = [];
  const client: FakeClient = {
    notifications,
    requests,
    request: vi.fn<ClientRequest>(),
    addNotificationHandler: vi.fn((handler: (notification: CodexServerNotification) => void) => {
      notifications.push(handler);
      return () => {
        const index = notifications.indexOf(handler);
        if (index >= 0) {
          notifications.splice(index, 1);
        }
      };
    }),
    addRequestHandler: vi.fn((handler: FakeClient["requests"][number]) => {
      requests.push(handler);
      return () => {
        const index = requests.indexOf(handler);
        if (index >= 0) {
          requests.splice(index, 1);
        }
      };
    }),
    emit: (notification) => {
      for (const handler of notifications) {
        handler(notification);
      }
    },
    handleRequest: async (request) => {
      for (const handler of requests) {
        const result = await handler(request);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    },
  };
  client.request.mockImplementation(async (method: string) => {
    if (method === "thread/fork") {
      return threadResult("side-thread");
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
        client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      });
      return turnStartResult("turn-1");
    }
    if (method === "thread/unsubscribe" || method === "turn/interrupt") {
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return client;
}

function mockCall(mock: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call;
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function activeDiagnosticToolKeys(events: DiagnosticEventPayload[]): Set<string> {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.execution.started") {
      active.add(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    } else if (
      event.type === "tool.execution.completed" ||
      event.type === "tool.execution.error" ||
      event.type === "tool.execution.blocked"
    ) {
      active.delete(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    }
  }
  return active;
}

function extractRelayIdFromThreadConfig(config: unknown): string {
  const record = config as Record<string, unknown> | undefined;
  let command: string | undefined;
  for (const key of [
    "hooks.PreToolUse",
    "hooks.PostToolUse",
    "hooks.PermissionRequest",
    "hooks.Stop",
  ]) {
    const entries = record?.[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
      command = entry.hooks?.find((hook) => typeof hook.command === "string")?.command;
      if (command) {
        break;
      }
    }
    if (command) {
      break;
    }
  }
  const match = command?.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

function codexHookCommand(config: unknown, key: string) {
  const entries = (config as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return (
    entries as Array<{ hooks?: Array<{ command?: string; timeout?: number; type?: string }> }>
  )
    .at(0)
    ?.hooks?.at(0);
}

function codexHookStateForEvent(
  hookState: Record<string, { enabled?: unknown; trusted_hash?: unknown }> | undefined,
  event: string,
) {
  return Object.entries(hookState ?? {}).find(([key]) => key.endsWith(`:${event}:0:0`))?.[1];
}

function threadResult(threadId: string) {
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/workspace",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    cwd: "/tmp/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
}

function turnStartResult(turnId: string) {
  return {
    turn: {
      id: turnId,
      threadId: "side-thread",
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function agentDelta(threadId: string, turnId: string, delta: string): CodexServerNotification {
  return {
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "agent-1", delta },
  };
}

function turnCompleted(threadId: string, turnId: string, text: string): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        threadId,
        status: "completed",
        items: [{ id: "agent-1", type: "agentMessage", text }],
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  };
}

function nativeCommandItem(
  id: string,
  status: "inProgress" | "completed",
  durationMs: number | null,
) {
  return {
    type: "commandExecution",
    id,
    command: "git status --short",
    cwd: "/tmp/workspace",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: status === "completed" ? "" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs,
  };
}

function sideParams(overrides: Partial<Parameters<typeof runCodexAppServerSideQuestion>[0]> = {}) {
  const authProfileId = Object.hasOwn(overrides, "authProfileId")
    ? overrides.authProfileId
    : "openai:work";
  const authProfileIdSource = Object.hasOwn(overrides, "authProfileIdSource")
    ? overrides.authProfileIdSource
    : "user";
  return {
    cfg: {} as never,
    agentDir: "/tmp/agent",
    provider: "openai",
    model: "gpt-5.5",
    question: "What changed?",
    sessionEntry: {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      updatedAt: 1,
    },
    resolvedReasoningLevel: "off",
    opts: {},
    isNewSession: false,
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    authProfileId,
    authProfileIdSource,
    preparedRuntimeAuth: {
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: authProfileId,
        forwardedAuthProfileSource: authProfileId ? authProfileIdSource : undefined,
        forwardedAuthProfileCandidateIds: authProfileId ? [authProfileId] : undefined,
        selectedAuthMode: authProfileId ? "token" : undefined,
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
      authProfileStore: {
        version: 1,
        profiles: authProfileId
          ? {
              [authProfileId]: {
                type: "token",
                provider: "openai",
                token: "test-token",
                expires: Date.now() + 60_000,
              },
            }
          : {},
      },
      authStorage: {} as never,
      modelRegistry: {} as never,
    },
    ...overrides,
  } satisfies Parameters<typeof runCodexAppServerSideQuestion>[0];
}

function platformPreparedRuntimeAuth(resolvedApiKey?: string) {
  return {
    plan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: "api-key",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.6",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
    authProfileStore: {
      version: 1 as const,
      profiles: {},
      order: { openai: [] },
    },
    authStorage: {} as never,
    modelRegistry: {} as never,
    ...(resolvedApiKey ? { resolvedApiKey } : {}),
  } satisfies Parameters<typeof runCodexAppServerSideQuestion>[0]["preparedRuntimeAuth"];
}

async function runSideQuestionWithManagedWebSearchCall(
  params: Parameters<typeof runCodexAppServerSideQuestion>[0] = sideParams(),
  options: { preserveToolFactory?: boolean } = {},
) {
  const client = createFakeClient();
  let toolResponse: unknown;
  if (!options.preserveToolFactory) {
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object", properties: {} },
        execute: toolExecuteMock,
      },
    ]);
  }
  client.request.mockImplementation(async (method: string) => {
    if (method === "thread/fork") {
      return threadResult("side-thread");
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      setTimeout(() => {
        void (async () => {
          toolResponse = await client.handleRequest({
            id: 42,
            method: "item/tool/call",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              callId: "tool-1",
              tool: "web_search",
              arguments: { query: "service providers" },
            },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "Search answer."));
        })();
      }, 0);
      return turnStartResult("turn-1");
    }
    if (method === "thread/unsubscribe" || method === "turn/interrupt") {
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  });
  getSharedCodexAppServerClientMock.mockResolvedValue(client);

  const result = await runCodexAppServerSideQuestion(params);
  const forkCall = client.request.mock.calls.find(([method]) => method === "thread/fork");
  const forkConfig = (forkCall?.[1] as { config?: Record<string, unknown> } | undefined)?.config;
  return { forkConfig, result, toolResponse };
}

describe("runCodexAppServerSideQuestion", () => {
  beforeEach(() => {
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    readCodexAppServerBindingMock.mockReset();
    isCodexAppServerNativeAuthProfileMock.mockReset();
    getSharedCodexAppServerClientMock.mockReset();
    refreshCodexAppServerAuthTokensMock.mockReset();
    createOpenClawCodingToolsMock.mockReset();
    toolExecuteMock.mockReset();
    handleCodexAppServerApprovalRequestMock.mockReset();
    resolveCodexProviderWebSearchSupportForClientMock.mockReset();
    withLeasedCodexAppServerClientStartSelectionRetryMock.mockReset();
    withLeasedCodexAppServerClientStartSelectionRetryMock.mockImplementation(
      async (params: SelectionRetryParams) =>
        await params.run(params.lease.client, {
          timeoutMs: params.options.timeoutMs ?? 60_000,
          signal: params.options.abandonSignal,
        }),
    );
    resolveCodexProviderWebSearchSupportForClientMock.mockResolvedValue("supported");

    toolExecuteMock.mockResolvedValue({
      content: [{ type: "text", text: "tool output" }],
    });
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "wiki_status",
        description: "Check wiki status",
        parameters: { type: "object", properties: {} },
        execute: toolExecuteMock,
      },
      {
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object", properties: {} },
        execute: toolExecuteMock,
      },
    ]);

    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(true);
    getSharedCodexAppServerClientMock.mockResolvedValue(createFakeClient());
    refreshCodexAppServerAuthTokensMock.mockResolvedValue({
      accessToken: "access-token",
      chatgptAccountId: "account-1",
      chatgptPlanType: "plus",
    });
  });

  afterEach(() => {
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    vi.useRealTimers();
  });

  it("forks an ephemeral side thread and returns the completed assistant text", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(
      sideParams({
        messageChannel: "discord",
        messageProvider: "discord-voice",
        chatId: "discord-native-room",
        chatType: "channel",
        sessionKey: "agent:main:conversation",
        sandboxSessionKey: "agent:main:runtime-policy",
        messageActionTurnCapability: "turn-capability-1",
        currentChannelId: "voice-room",
        agentAccountId: "account-1",
        messageTo: "channel-1",
        messageThreadId: "thread-1",
        groupId: "group-1",
        groupChannel: "#ops",
        groupSpace: "workspace-1",
        spawnedBy: "agent:main:parent",
        senderId: "sender-1",
        senderName: "Rosita",
        senderUsername: "rosita",
        senderE164: "+15550001",
        senderIsOwner: true,
      }),
    );

    expect(result).toEqual({ text: "Side answer." });
    expect(mockCall(getSharedCodexAppServerClientMock)[0]).toMatchObject({
      preparedAuth: {
        kind: "profile",
        profileId: "openai:work",
        store: expect.objectContaining({
          profiles: expect.objectContaining({ "openai:work": expect.any(Object) }),
        }),
      },
    });
    expect(mockCall(getSharedCodexAppServerClientMock)[0]).not.toHaveProperty("authProfileId");
    const forkCall = mockCall(client.request);
    expect(forkCall?.[0]).toBe("thread/fork");
    const forkParams = forkCall?.[1] as Record<string, unknown> | undefined;
    expect(Object.keys(forkParams ?? {}).toSorted()).toEqual([
      "approvalPolicy",
      "approvalsReviewer",
      "config",
      "cwd",
      "developerInstructions",
      "ephemeral",
      "model",
      "sandbox",
      "threadId",
      "threadSource",
    ]);
    expect(forkParams?.threadId).toBe("parent-thread");
    expect(forkParams?.model).toBe("gpt-5.5");
    expect(forkParams).not.toHaveProperty("personality");
    expect(forkParams?.approvalPolicy).toBe("on-request");
    expect(forkParams?.sandbox).toBe("workspace-write");
    expect(forkParams?.ephemeral).toBe(true);
    expect(forkParams?.threadSource).toBe("user");
    expect(forkParams?.approvalsReviewer).toBe("user");
    expect(forkParams?.cwd).toBe("/tmp/workspace");
    expect(forkParams?.config).toEqual({
      "features.goals": false,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
    expect(forkParams?.developerInstructions).toContain("You are in a side conversation");
    expect(forkParams?.developerInstructions).toContain(
      "Only instructions submitted after the side-conversation boundary are active.",
    );
    expect(forkCall?.[2]).toEqual({ timeoutMs: 60_000, signal: undefined });

    const injectCall = mockCall(client.request, 1);
    expect(injectCall?.[0]).toBe("thread/inject_items");
    const injectParams = injectCall?.[1] as
      | { threadId?: string; items?: Array<{ type?: string; role?: string; content?: unknown }> }
      | undefined;
    expect(injectParams?.threadId).toBe("side-thread");
    expect(injectParams?.items).toHaveLength(1);
    expect(injectParams?.items?.[0]?.type).toBe("message");
    expect(injectParams?.items?.[0]?.role).toBe("user");
    expect(injectCall?.[2]).toEqual({ timeoutMs: 60_000, signal: undefined });
    const injectedItem = injectParams?.items?.[0] as
      | { content?: Array<{ text?: string }> }
      | undefined;
    const injectedText = injectedItem?.content?.[0]?.text;
    expect(injectedText).toContain(
      "External tools may be available according to this thread's current permissions",
    );
    expect(injectedText).toContain(
      "unless the user explicitly asks for that mutation after this boundary",
    );
    const turnStartCall = client.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall).toEqual([
      "turn/start",
      {
        threadId: "side-thread",
        input: [{ type: "text", text: "What changed?", text_elements: [] }],
        cwd: "/tmp/workspace",
        model: "gpt-5.5",
        personality: "none",
        effort: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.5",
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
      { timeoutMs: 60_000, signal: undefined },
    ]);
    const turnStartParams = turnStartCall?.[1] as Record<string, unknown> | undefined;
    expect(turnStartParams).not.toHaveProperty("approvalPolicy");
    expect(turnStartParams).not.toHaveProperty("sandboxPolicy");
    expect(client.request.mock.calls.at(-1)).toEqual([
      "thread/unsubscribe",
      { threadId: "side-thread" },
      { timeoutMs: 60_000 },
    ]);
    expect(client.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    const [toolOptions] = mockCall(createOpenClawCodingToolsMock);
    expect(toolOptions).toHaveProperty("agentDir", "/tmp/agent");
    expect(toolOptions).toHaveProperty("workspaceDir", "/tmp/workspace");
    expect(toolOptions).toHaveProperty("sessionId", "session-1");
    expect(toolOptions).toHaveProperty("modelProvider", "openai");
    expect(toolOptions).toHaveProperty("modelId", "gpt-5.5");
    expect(toolOptions).toHaveProperty("messageProvider", "discord");
    expect(toolOptions).toHaveProperty("toolPolicyMessageProvider", "discord-voice");
    expect(toolOptions).toHaveProperty("chatType", "channel");
    expect(toolOptions).toHaveProperty("currentChannelId", "voice-room");
    expect(toolOptions).toHaveProperty("nativeChannelId", "discord-native-room");
    expect(toolOptions).toMatchObject({
      agentAccountId: "account-1",
      sessionKey: "agent:main:runtime-policy",
      runSessionKey: "agent:main:conversation",
      messageTo: "channel-1",
      messageThreadId: "thread-1",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
      senderIsOwner: true,
      messageActionTurnCapability: "turn-capability-1",
    });
    expect(toolOptions).toHaveProperty("requireExplicitMessageTarget", true);
  });

  it("rebinds side-question handlers when selection retry replaces the client", async () => {
    const initialClient = createFakeClient();
    const replacementClient = createFakeClient();
    replacementClient.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        expect(initialClient.notifications).toHaveLength(1);
        expect(initialClient.requests).toHaveLength(1);
        expect(replacementClient.notifications).toHaveLength(2);
        expect(replacementClient.requests).toHaveLength(2);
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          replacementClient.emit(agentDelta("side-thread", "turn-1", "Replacement answer."));
          replacementClient.emit(turnCompleted("side-thread", "turn-1", "Replacement answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(initialClient);
    withLeasedCodexAppServerClientStartSelectionRetryMock.mockImplementationOnce(
      async (params: SelectionRetryParams) => {
        expect(params.lease.client).toBe(initialClient);
        params.lease.client = replacementClient;
        params.onClientChange(replacementClient);
        return await params.run(replacementClient, {
          timeoutMs: params.options.timeoutMs ?? 60_000,
          signal: params.options.abandonSignal,
        });
      },
    );

    await expect(runCodexAppServerSideQuestion(sideParams())).resolves.toEqual({
      text: "Replacement answer.",
    });

    // Only the physical-client runtime observers remain after side-question cleanup.
    expect(initialClient.notifications).toHaveLength(1);
    expect(initialClient.requests).toHaveLength(1);
    expect(replacementClient.notifications).toHaveLength(1);
    expect(replacementClient.requests).toHaveLength(1);
  });

  it("rejects a Platform plan before binding OAuth can fill missing prepared auth", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "openai",
          model: "gpt-5.6",
          runtimeModel: {
            provider: "openai",
            id: "gpt-5.6",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          } as never,
          authProfileId: undefined,
          authProfileIdSource: undefined,
          preparedRuntimeAuth: platformPreparedRuntimeAuth(),
        }),
      ),
    ).rejects.toThrow("Prepared Codex API-key route is missing its resolved API key");

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(isCodexAppServerNativeAuthProfileMock).not.toHaveBeenCalled();
  });

  it("rejects an unprofiled subscription plan before native account inference", async () => {
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          authProfileId: undefined,
          authProfileIdSource: undefined,
        }),
      ),
    ).rejects.toThrow(
      "Prepared Codex subscription route requires a scoped native OAuth or token profile",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(isCodexAppServerNativeAuthProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: undefined, authProfileStore: expect.any(Object) }),
    );
  });

  it("rejects an API-key profile for a prepared subscription route", async () => {
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
    const params = sideParams();
    params.preparedRuntimeAuth.authProfileStore.profiles["openai:work"] = {
      type: "api_key",
      provider: "openai",
      key: "platform-key",
    };

    await expect(runCodexAppServerSideQuestion(params)).rejects.toThrow(
      "Prepared Codex subscription route requires a scoped native OAuth or token profile",
    );
    expect(isCodexAppServerNativeAuthProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:work",
        authProfileStore: params.preparedRuntimeAuth.authProfileStore,
      }),
    );
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("starts a Platform side question with only its authoritative prepared API key", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
    const preparedRuntimeAuth = platformPreparedRuntimeAuth("platform-key");

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "openai",
          model: "gpt-5.6",
          runtimeModel: {
            provider: "openai",
            id: "gpt-5.6",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          } as never,
          authProfileId: undefined,
          authProfileIdSource: undefined,
          preparedRuntimeAuth,
        }),
      ),
    ).resolves.toEqual({ text: "Side answer." });

    expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "platform-key" },
      }),
    );
    expect(mockCall(getSharedCodexAppServerClientMock)[0]).not.toHaveProperty("authProfileId");
    expect(isCodexAppServerNativeAuthProfileMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:work" }),
    );
  });

  it("allocates one fallback run ID per side-question invocation", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await runCodexAppServerSideQuestion(sideParams());
    await runCodexAppServerSideQuestion(sideParams());

    const runIds = createOpenClawCodingToolsMock.mock.calls.map(
      ([options]) => (options as { runId: string }).runId,
    );
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(runIds[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(runIds).size).toBe(2);
  });

  it("uses the default supervision runtime, native auth, and exact bound model pair", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      threadId: "parent-thread",
      connectionScope: "supervision",
      supervisionSourceThreadId: "source-thread",
      cwd: "/tmp/workspace",
      model: "gpt-5.5",
      modelProvider: "openai",
      appServerRuntimeFingerprint: supervisionConnectionFingerprint(),
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "anthropic",
          model: "claude-opus-4-6",
          runtimeModel: {
            id: "claude-opus-4-6",
            provider: "anthropic",
            compat: { supportsTools: false },
          } as never,
          authProfileId: "openai:outer",
        }),
        { pluginConfig: { supervision: { enabled: true } } },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
    const forkCall = client.request.mock.calls.find(([method]) => method === "thread/fork");
    expect(forkCall?.[1]).toMatchObject({
      threadId: "parent-thread",
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    const turnCall = client.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnCall?.[1]).toMatchObject({ model: "gpt-5.5" });
    expect(turnCall?.[1]).not.toHaveProperty("effort");
    expect(turnCall?.[1]).not.toHaveProperty("collaborationMode");
    expect(turnCall?.[1]).not.toHaveProperty("personality");
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openai", modelId: "gpt-5.5" }),
    );
  });

  it("rejects an incomplete supervised model pair before selecting a client", async () => {
    readCodexAppServerBindingMock.mockResolvedValue({
      threadId: "parent-thread",
      connectionScope: "supervision",
      supervisionSourceThreadId: "source-thread",
      cwd: "/tmp/workspace",
      model: "gpt-5.5",
      appServerRuntimeFingerprint: supervisionConnectionFingerprint(),
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { supervision: { enabled: true } },
      }),
    ).rejects.toThrow("missing its native model and provider");
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("cleans up a supervised fork that returns a different native model pair", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      threadId: "parent-thread",
      connectionScope: "supervision",
      supervisionSourceThreadId: "source-thread",
      cwd: "/tmp/workspace",
      model: "gpt-5.4",
      modelProvider: "openai",
      appServerRuntimeFingerprint: supervisionConnectionFingerprint(),
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { supervision: { enabled: true } },
      }),
    ).rejects.toThrow("did not preserve its native model and provider");

    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/fork",
      "thread/unsubscribe",
    ]);
    expect(client.request).not.toHaveBeenCalledWith(
      "thread/inject_items",
      expect.anything(),
      expect.anything(),
    );
    expect(client.request).not.toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    );
  });

  it("replays app-scoped reviewer policy into side-thread forks", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 2,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      pluginAppPolicyContext: {
        fingerprint: "mixed-plugin-policy",
        apps: {
          "ask-app": {
            configKey: "ask",
            marketplaceName: "openai",
            pluginName: "ask",
            allowDestructiveActions: true,
            destructiveApprovalMode: "ask",
            mcpServerNames: ["ask"],
          },
          "true-app": {
            configKey: "true",
            marketplaceName: "openai",
            pluginName: "true",
            allowDestructiveActions: true,
            destructiveApprovalMode: "allow",
            mcpServerNames: ["true"],
          },
          "false-app": {
            configKey: "false",
            marketplaceName: "openai",
            pluginName: "false",
            allowDestructiveActions: false,
            destructiveApprovalMode: "deny",
            mcpServerNames: ["false"],
          },
          "auto-app": {
            configKey: "auto",
            marketplaceName: "openai",
            pluginName: "auto",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: ["auto"],
          },
        },
        pluginAppIds: {
          ask: ["ask-app"],
          true: ["true-app"],
          false: ["false-app"],
          auto: ["auto-app"],
        },
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    expect(forkParams?.approvalsReviewer).toBe("auto_review");
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config).not.toHaveProperty("approvals_reviewer");
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "ask-app": {
        enabled: true,
        approvals_reviewer: "user",
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
      "auto-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
      "false-app": {
        enabled: true,
        destructive_enabled: false,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
      "true-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    });
  });

  it("disables hosted search when side-question sender policy removes managed web_search", async () => {
    createOpenClawCodingToolsMock.mockImplementation((options: { senderId?: string }) =>
      options.senderId === "restricted-sender"
        ? []
        : [
            {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object", properties: {} },
              execute: toolExecuteMock,
            },
          ],
    );

    const { forkConfig } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({ senderId: "restricted-sender" }),
      { preserveToolFactory: true },
    );

    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it.each([
    { name: "deny all", toolsAllow: [] },
    { name: "narrow allowlist", toolsAllow: ["message"] },
  ])("rejects /btw before forking when effective toolsAllow is $name", async ({ toolsAllow }) => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          messageChannel: "telegram",
          messageProvider: "telegram",
          senderId: "restricted-sender",
          toolsAllow,
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because the effective tool policy restricts Codex native tools for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(resolveCodexProviderWebSearchSupportForClientMock).not.toHaveBeenCalled();
  });

  it("applies native search restrictions to side forks and suppresses managed search", async () => {
    const { forkConfig, result, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        cfg: {
          tools: {
            web: {
              search: {
                openaiCodex: {
                  allowedDomains: ["example.com"],
                },
              },
            },
          },
        } as never,
      }),
    );

    expect(result).toEqual({ text: "Search answer." });
    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "cached",
      "tools.web_search.allowed_domains": ["example.com"],
    });
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
    });
    expect(toolExecuteMock).not.toHaveBeenCalled();
  });

  it("preserves managed web_search while planning hosted search for Responses side questions", async () => {
    createOpenClawCodingToolsMock.mockImplementation(
      (options: { suppressManagedWebSearch?: boolean }) =>
        options.suppressManagedWebSearch === false
          ? [
              {
                name: "web_search",
                description: "Search the web",
                parameters: { type: "object", properties: {} },
                execute: toolExecuteMock,
              },
            ]
          : [],
    );

    const { forkConfig, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        runtimeModel: {
          id: "gpt-5.5",
          provider: "openai",
          api: "openai-chatgpt-responses",
        } as never,
      }),
      { preserveToolFactory: true },
    );

    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "cached",
    });
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
    });
    expect(toolExecuteMock).not.toHaveBeenCalled();
  });

  it("disables search for side forks when the configured provider lacks hosted search", async () => {
    resolveCodexProviderWebSearchSupportForClientMock.mockResolvedValue("unsupported");

    const { forkConfig, result, toolResponse } = await runSideQuestionWithManagedWebSearchCall();

    expect(result).toEqual({ text: "Search answer." });
    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
    });
    expect(toolExecuteMock).not.toHaveBeenCalled();
  });

  it("disables search for side forks when a managed provider is selected", async () => {
    const { forkConfig, result, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        cfg: {
          tools: {
            web: {
              search: {
                provider: "brave",
              },
            },
          },
        } as never,
      }),
    );

    expect(result).toEqual({ text: "Search answer." });
    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
    });
    expect(toolExecuteMock).not.toHaveBeenCalled();
    expect(resolveCodexProviderWebSearchSupportForClientMock).not.toHaveBeenCalled();
  });

  it("disables both search surfaces for side forks when web search is disabled", async () => {
    const { forkConfig, result, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        cfg: {
          tools: {
            web: {
              search: {
                enabled: false,
              },
            },
          },
        } as never,
      }),
    );

    expect(result).toEqual({ text: "Search answer." });
    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
    });
    expect(toolExecuteMock).not.toHaveBeenCalled();
    expect(resolveCodexProviderWebSearchSupportForClientMock).not.toHaveBeenCalled();
  });

  it("rejects /btw before forking when the current OpenClaw session is sandboxed", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { agents: { defaults: { sandbox: { mode: "all" } } } } as never,
          sessionKey: "sandboxed-session",
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("checks /btw native execution against the runtime-policy session", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: {
            agents: {
              defaults: { sandbox: { mode: "non-main", scope: "agent" } },
              list: [{ id: "main" }],
            },
          } as never,
          sessionKey: "agent:main:main",
          sandboxSessionKey: "agent:main:whatsapp:personal:direct:15555550123",
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("rejects /btw before forking when exec host=node is active", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { tools: { exec: { host: "node", node: "worker-1" } } } as never,
          sessionKey: "node-session",
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("installs native hook relay config for opted-in side threads", async () => {
    const client = createFakeClient();
    let relayIdDuringFork: string | undefined;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        const config = (requestParams as { config?: Record<string, unknown> }).config;
        relayIdDuringFork = extractRelayIdFromThreadConfig(config);
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork),
        ).toMatchObject({
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-side-1",
          channelId: "voice-room",
          allowedEvents: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
        });
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          sessionKey: "agent:main:session-1",
          messageChannel: "discord",
          messageProvider: "discord-voice",
          currentChannelId: "discord:voice-room",
          opts: { runId: "run-side-1" },
        }),
        { nativeHookRelay: { enabled: true, hookTimeoutSec: 9 } },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config?.["features.hooks"]).toBe(true);
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.["features.code_mode_only"]).toBe(false);
    expect(config?.["hooks.PermissionRequest"]).toEqual([]);
    const preToolUseHooks = config?.["hooks.PreToolUse"] as
      | Array<{ hooks?: Array<{ command?: string; timeout?: number; type?: string }> }>
      | undefined;
    const preToolUseCommand = preToolUseHooks?.[0]?.hooks?.[0];
    expect(preToolUseCommand?.type).toBe("command");
    expect(preToolUseCommand?.timeout).toBe(9);
    expect(preToolUseCommand?.command).toContain("--event pre_tool_use");
    const hookState = config?.["hooks.state"] as
      | Record<string, { enabled?: unknown; trusted_hash?: unknown }>
      | undefined;
    const preToolUseState = codexHookStateForEvent(hookState, "pre_tool_use");
    expect(preToolUseState?.enabled).toBe(true);
    expect(preToolUseState?.trusted_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const permissionRequestState = codexHookStateForEvent(hookState, "permission_request");
    expect(permissionRequestState).toEqual({ enabled: false });
    const turnStartCall = client.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).not.toHaveProperty("config");
    expect(relayIdDuringFork).toBeDefined();
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-side-1" }),
    );
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
    ).toBeUndefined();
  });

  it("omits the loop-detection PreToolUse subprocess for side threads when disabled", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { tools: { loopDetection: { enabled: true } } } as never,
          sessionKey: "agent:main:session-1",
        }),
        {
          pluginConfig: {
            appServer: { loopDetectionPreToolUseRelay: false },
          },
          nativeHookRelay: { enabled: true },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config?.["features.hooks"]).toBe(true);
    expect(config?.["hooks.PreToolUse"]).toEqual([]);
    const hookState = config?.["hooks.state"] as
      | Record<string, { enabled?: unknown; trusted_hash?: unknown }>
      | undefined;
    expect(codexHookStateForEvent(hookState, "pre_tool_use")).toEqual({ enabled: false });
  });

  it("forwards side-thread command approvals through the active native hook relay", async () => {
    const client = createFakeClient();
    let relayIdDuringFork: string | undefined;
    let approvalResponse: unknown;
    handleCodexAppServerApprovalRequestMock.mockResolvedValueOnce({ decision: "decline" });
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        const config = (requestParams as { config?: Record<string, unknown> }).config;
        relayIdDuringFork = extractRelayIdFromThreadConfig(config);
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            approvalResponse = await client.handleRequest({
              id: 42,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                itemId: "cmd-side",
                command: "/bin/bash -lc 'node -v'",
                cwd: "/tmp/workspace",
              },
            });
            client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          sessionKey: "agent:main:session-1",
          messageChannel: "discord",
          messageProvider: "discord-voice",
          opts: { runId: "run-side-approval" },
        }),
        { nativeHookRelay: { enabled: true } },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    expect(approvalResponse).toEqual({ decision: "decline" });
    expect(handleCodexAppServerApprovalRequestMock).toHaveBeenCalledTimes(1);
    const approvalArgs = handleCodexAppServerApprovalRequestMock.mock.calls[0]?.[0] as
      | {
          method?: string;
          requestParams?: Record<string, unknown>;
          threadId?: string;
          turnId?: string;
          paramsForRun?: { messageChannel?: string; messageProvider?: string };
          nativeHookRelay?: { relayId?: string; allowedEvents?: readonly string[] };
        }
      | undefined;
    expect(approvalArgs).toMatchObject({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "side-thread",
        turnId: "turn-1",
        itemId: "cmd-side",
        command: "/bin/bash -lc 'node -v'",
        cwd: "/tmp/workspace",
      },
      threadId: "side-thread",
      turnId: "turn-1",
      autoApprove: false,
      paramsForRun: {
        messageChannel: "discord",
        messageProvider: "discord-voice",
      },
    });
    expect(approvalArgs?.nativeHookRelay).toMatchObject({
      relayId: relayIdDuringFork,
      allowedEvents: expect.arrayContaining(["pre_tool_use"]),
    });
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
    ).toBeUndefined();
  });

  it("unregisters the native hook relay when side thread fork fails", async () => {
    const client = createFakeClient();
    let relayIdDuringFork: string | undefined;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        relayIdDuringFork = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork),
        ).toBeDefined();
        throw new Error("fork failed");
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { tools: { loopDetection: { enabled: true } } } as never,
          sessionKey: "agent:main:session-1",
        }),
        { nativeHookRelay: { enabled: true } },
      ),
    ).rejects.toThrow("fork failed");

    expect(relayIdDuringFork).toBeDefined();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
    ).toBeUndefined();
  });

  it("includes permission request native hooks for side threads with yolo approval policy", async () => {
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { tools: { loopDetection: { enabled: true } } } as never,
          sessionKey: "agent:main:session-1",
        }),
        { nativeHookRelay: { enabled: true } },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams?.approvalPolicy).toBe("never");
    expect(codexHookCommand(config, "hooks.PermissionRequest")?.command).toContain(
      "--event permission_request",
    );
    expect(codexHookCommand(config, "hooks.PreToolUse")?.command).toContain("--event pre_tool_use");
  });

  it("preserves explicitly configured side-thread native hook events", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        nativeHookRelay: { enabled: true, events: ["permission_request"] },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(codexHookCommand(config, "hooks.PermissionRequest")?.command).toContain(
      "--event permission_request",
    );
    expect(config?.["hooks.PreToolUse"]).toEqual([]);
    expect(config?.["hooks.PostToolUse"]).toEqual([]);
    expect(config?.["hooks.Stop"]).toEqual([]);
    const hookState = config?.["hooks.state"] as
      | Record<string, { enabled?: unknown; trusted_hash?: unknown }>
      | undefined;
    expect(codexHookStateForEvent(hookState, "permission_request")?.enabled).toBe(true);
    expect(codexHookStateForEvent(hookState, "pre_tool_use")).toEqual({ enabled: false });
    expect(codexHookStateForEvent(hookState, "post_tool_use")).toEqual({ enabled: false });
    expect(codexHookStateForEvent(hookState, "stop")).toEqual({ enabled: false });
  });

  it("sends clearing native hook config when side-thread relay is disabled", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), { nativeHookRelay: { enabled: false } }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config).toMatchObject({
      "features.hooks": false,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
    expect(config).not.toHaveProperty("hooks.state");
  });

  it("passes Codex code-mode-only opt-in to side-thread forks", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { codeModeOnly: true } },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.["features.code_mode_only"]).toBe(true);
  });

  it("applies network-proxy config to side-thread forks", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: {
          appServer: {
            networkProxy: {
              enabled: true,
              profileName: "side-proxy",
              domains: { "api.openai.com": "allow" },
              unixSockets: { "/tmp/proxy.sock": "allow" },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams).not.toHaveProperty("sandbox");
    expect(config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "side-proxy",
      permissions: {
        "side-proxy": {
          filesystem: {
            ":minimal": "read",
            ":project_roots": { ".": "write" },
          },
          network: {
            enabled: true,
            domains: { "api.openai.com": "allow" },
            unix_sockets: { "/tmp/proxy.sock": "allow" },
            allow_upstream_proxy: true,
            proxy_url: "http://127.0.0.1:3128",
          },
        },
      },
    });
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.["features.code_mode_only"]).toBe(false);
  });

  it("keeps Codex code-mode-only while disabling Guardian for provider-qualified local models", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "codex",
          model: "lmstudio/local-model",
        }),
        {
          pluginConfig: {
            appServer: {
              mode: "guardian",
              codeModeOnly: true,
            },
          },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams?.model).toBe("local-model");
    expect(forkParams?.modelProvider).toBe("lmstudio");
    expect(forkParams?.approvalPolicy).toBe("on-request");
    expect(forkParams?.sandbox).toBe("workspace-write");
    expect(forkParams?.approvalsReviewer).toBe("user");
    expect(resolveCodexProviderWebSearchSupportForClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProviderOverride: "lmstudio",
      }),
    );
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.["features.code_mode_only"]).toBe(true);
  });

  it("uses bound local model providers when disabling Guardian for side-thread forks", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "codex",
          model: "local-model",
        }),
        {
          pluginConfig: {
            appServer: {
              mode: "guardian",
              codeModeOnly: true,
            },
          },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams?.model).toBe("local-model");
    expect(forkParams?.modelProvider).toBe("lmstudio");
    expect(forkParams?.approvalPolicy).toBe("on-request");
    expect(forkParams?.sandbox).toBe("workspace-write");
    expect(forkParams?.approvalsReviewer).toBe("user");
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.["features.code_mode_only"]).toBe(true);
  });

  it("uses bound local providers for side-thread model ids that contain slashes", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "codex",
          model: "openai/gpt-oss-20b",
        }),
        {
          pluginConfig: {
            appServer: {
              mode: "guardian",
              codeModeOnly: true,
            },
          },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    expect(forkParams?.model).toBe("openai/gpt-oss-20b");
    expect(forkParams?.modelProvider).toBe("lmstudio");
    expect(forkParams?.approvalsReviewer).toBe("user");
  });

  it("does not apply bound local model providers to provider-qualified side-thread models", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "codex",
          model: "openai/gpt-5.5",
        }),
        {
          pluginConfig: {
            appServer: {
              mode: "guardian",
              codeModeOnly: true,
            },
          },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    expect(forkParams?.model).toBe("gpt-5.5");
    expect(forkParams).not.toHaveProperty("modelProvider");
    expect(forkParams?.approvalsReviewer).toBe("auto_review");
  });

  it("does not inherit a bound local provider for explicit native OpenAI side threads", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(true);
    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "openai",
          model: "gpt-5.5",
        }),
        {
          pluginConfig: {
            appServer: {
              mode: "guardian",
            },
          },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    expect(forkParams?.model).toBe("gpt-5.5");
    expect(forkParams).not.toHaveProperty("modelProvider");
    expect(forkParams?.approvalsReviewer).toBe("auto_review");
  });

  it("keeps native hook relays alive across side-thread startup and completion timeouts", async () => {
    const client = createFakeClient();
    const requestTimeoutMs = 400_000;
    const completionTimeoutMs = 700_000;
    const expectedRelayTtlMs = requestTimeoutMs * 3 + completionTimeoutMs + 5 * 60_000;
    let relayIdDuringFork: string | undefined;
    let startedAtMs = 0;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        relayIdDuringFork = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        const registration =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork);
        if (!registration) {
          throw new Error("Expected native hook relay registration");
        }
        expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(expectedRelayTtlMs);
        expect(registration.expiresAtMs - startedAtMs).toBeLessThan(expectedRelayTtlMs + 10_000);
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    startedAtMs = Date.now();
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { tools: { loopDetection: { enabled: true } } } as never,
          sessionKey: "agent:main:session-1",
        }),
        {
          pluginConfig: {
            appServer: {
              requestTimeoutMs,
              turnCompletionIdleTimeoutMs: completionTimeoutMs,
            },
          },
          nativeHookRelay: { enabled: true },
        },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    expect(relayIdDuringFork).toBeDefined();
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relayIdDuringFork!,
    );
    expect(registration).toBeUndefined();
    const forkCall = mockCall(client.request);
    const forkOptions = forkCall[2] as { timeoutMs?: number } | undefined;
    expect(forkOptions?.timeoutMs).toBe(requestTimeoutMs);
    const config = (forkCall[1] as { config?: Record<string, unknown> }).config;
    const relayId = extractRelayIdFromThreadConfig(config);
    expect(relayId).toBe(relayIdDuringFork);
  });

  it("emits a buffered native pre-tool failure when side turn startup fails", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let relayId: string | undefined;
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        relayId = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        if (!relayId) {
          throw new Error("Expected native hook relay id");
        }
        reportPreToolUseFailure =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            relayId,
          )?.onPreToolUseFailure;
        throw new Error("side turn start exploded");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await expect(
        runCodexAppServerSideQuestion(sideParams(), {
          nativeHookRelay: { enabled: true },
        }),
      ).rejects.toThrow("side turn start exploded");
      await reportPreToolUseFailure?.({
        toolName: "exec",
        toolCallId: "side-turn-start-failure-tool",
        disposition: "failed",
        durationMs: 5,
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "side-turn-start-failure-tool",
        terminalReason: "failed",
      }),
    );
  });

  it("preserves a late native pre-tool failure after side turn cleanup", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        const relayId = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        reportPreToolUseFailure =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            relayId,
          )?.onPreToolUseFailure;
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await expect(
        runCodexAppServerSideQuestion(sideParams(), {
          nativeHookRelay: { enabled: true },
        }),
      ).resolves.toEqual({ text: "Side answer." });
      await reportPreToolUseFailure?.({
        toolName: "exec",
        toolCallId: "late-side-tool",
        disposition: "failed",
        durationMs: 5,
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "late-side-tool",
        terminalReason: "failed",
      }),
    );
  });

  it("coalesces a native pre-tool failure that arrives during side turn cleanup", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        const relayId = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        reportPreToolUseFailure =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            relayId,
          )?.onPreToolUseFailure;
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit({
            method: "item/started",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              item: nativeCommandItem("side-cleanup-failure-tool", "inProgress", null),
            },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe") {
        await reportPreToolUseFailure?.({
          toolName: "exec",
          toolCallId: "side-cleanup-failure-tool",
          disposition: "failed",
          durationMs: 5,
        });
        return {};
      }
      if (method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await expect(
        runCodexAppServerSideQuestion(sideParams(), {
          nativeHookRelay: { enabled: true },
        }),
      ).resolves.toEqual({ text: "Side answer." });
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(
      diagnosticEvents.filter(
        (event) =>
          event.type.startsWith("tool.execution.") &&
          "toolCallId" in event &&
          event.toolCallId === "side-cleanup-failure-tool",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "tool.execution.started",
        toolCallId: "side-cleanup-failure-tool",
      }),
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "side-cleanup-failure-tool",
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      }),
    ]);
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
  });

  it("bridges side-thread dynamic tool requests to OpenClaw tools", async () => {
    const client = createFakeClient();
    let toolResponse: unknown;
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            toolResponse = await client.handleRequest({
              id: 42,
              method: "item/tool/call",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                callId: "tool-1",
                tool: "wiki_status",
                arguments: { topic: "AGENTS.md" },
              },
            });
            client.emit(agentDelta("side-thread", "turn-1", "Tool answer."));
            client.emit(turnCompleted("side-thread", "turn-1", "Tool answer."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(sideParams());

    expect(result).toEqual({ text: "Tool answer." });
    const [toolCallId, toolArguments, toolSignal, toolOptions] = mockCall(toolExecuteMock);
    expect(toolExecuteMock).toHaveBeenCalledTimes(1);
    expect(toolCallId).toBe("tool-1");
    expect(toolArguments).toEqual({ topic: "AGENTS.md" });
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolOptions).toBeUndefined();
    expect(toolResponse).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "tool output" }],
    });
  });

  it("omits computer control from side threads without a compaction owner", async () => {
    const client = createFakeClient();
    const computerExecute = vi.fn();
    let toolResponse: unknown;
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "computer",
        description: "Control a desktop",
        parameters: { type: "object", properties: {} },
        execute: computerExecute,
      },
    ]);
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            toolResponse = await client.handleRequest({
              id: 43,
              method: "item/tool/call",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                callId: "computer-1",
                tool: "computer",
                arguments: { action: "screenshot" },
              },
            });
            client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
            client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(runCodexAppServerSideQuestion(sideParams())).resolves.toEqual({
      text: "Side answer.",
    });
    expect(computerExecute).not.toHaveBeenCalled();
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: computer" }],
    });
  });

  it("aborts active side tools before waiting for thread cleanup", async () => {
    const client = createFakeClient();
    let releaseUnsubscribe: (() => void) | undefined;
    const unsubscribePending = new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve;
    });
    let toolAborted = false;
    let resolveToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      resolveToolStarted = resolve;
    });
    toolExecuteMock.mockImplementation(
      (_callId: string, _args: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          resolveToolStarted?.();
          signal?.addEventListener(
            "abort",
            () => {
              toolAborted = true;
              reject(new Error("side tool aborted"));
            },
            { once: true },
          );
        }),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            void client.handleRequest({
              id: 42,
              method: "item/tool/call",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                callId: "tool-1",
                tool: "wiki_status",
                arguments: {},
              },
            });
            await toolStarted;
            client.emit(turnCompleted("side-thread", "turn-1", "Finished answer."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe") {
        await unsubscribePending;
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const run = runCodexAppServerSideQuestion(sideParams());
    await vi.waitFor(() =>
      expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
        true,
      ),
    );
    expect(toolAborted).toBe(true);
    releaseUnsubscribe?.();
    await expect(run).resolves.toEqual({ text: "Finished answer." });
  });

  it("clears side-thread dynamic tool diagnostics at the app-server request boundary", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            await client.handleRequest({
              id: 42,
              method: "item/tool/call",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                callId: "tool-1",
                tool: "wiki_status",
                arguments: { topic: "AGENTS.md" },
              },
            });
            client.emit(agentDelta("side-thread", "turn-1", "Tool answer."));
            client.emit(turnCompleted("side-thread", "turn-1", "Tool answer."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await runCodexAppServerSideQuestion(
      sideParams({
        opts: { runId: "run-side-diagnostics" },
      }),
    );
    await flushDiagnosticEvents();
    unsubscribeDiagnostics();

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "wiki_status",
        toolCallId: "tool-1",
      },
      {
        type: "tool.execution.completed",
        toolName: "wiki_status",
        toolCallId: "tool-1",
      },
    ]);
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
  });

  it("projects native side-thread tool notifications into trusted diagnostics", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          client.emit({
            method: "item/started",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              item: nativeCommandItem("native-tool-1", "inProgress", null),
            },
          });
          client.emit({
            method: "item/completed",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              item: nativeCommandItem("native-tool-1", "completed", 12),
            },
          });
          const webSearchItem = {
            type: "webSearch",
            id: "native-search-1",
            query: "sensitive side-thread query",
            action: {
              type: "search",
              query: "sensitive side-thread query",
              queries: null,
            },
          };
          client.emit({
            method: "item/started",
            params: { threadId: "side-thread", turnId: "turn-1", item: webSearchItem },
          });
          client.emit({
            method: "item/completed",
            params: { threadId: "side-thread", turnId: "turn-1", item: webSearchItem },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "Native tool answer."));
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "agent:side-agent:main",
          opts: { runId: "run-side-native-tool" },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    type ToolExecutionEvent = Extract<
      DiagnosticEventPayload,
      {
        type:
          | "tool.execution.started"
          | "tool.execution.completed"
          | "tool.execution.error"
          | "tool.execution.blocked";
      }
    >;
    const toolEvents = diagnosticEvents.filter((event): event is ToolExecutionEvent =>
      event.type.startsWith("tool.execution."),
    );
    expect(
      toolEvents.map((event) => ({
        type: event.type,
        agentId: event.agentId,
        toolName: "toolName" in event ? event.toolName : undefined,
        toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
        durationMs: "durationMs" in event ? event.durationMs : undefined,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        agentId: "side-agent",
        toolName: "bash",
        toolCallId: "native-tool-1",
        durationMs: undefined,
      },
      {
        type: "tool.execution.completed",
        agentId: "side-agent",
        toolName: "bash",
        toolCallId: "native-tool-1",
        durationMs: 12,
      },
      {
        type: "tool.execution.started",
        agentId: "side-agent",
        toolName: "web_search",
        toolCallId: "native-search-1",
        durationMs: undefined,
      },
      {
        type: "tool.execution.error",
        agentId: "side-agent",
        toolName: "web_search",
        toolCallId: "native-search-1",
        durationMs: expect.any(Number),
      },
    ]);
    expect(toolEvents.at(-1)).toMatchObject({
      errorCode: "tool_outcome_unknown",
      terminalReason: "failed",
    });
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
    expect(JSON.stringify(toolEvents)).not.toContain("sensitive side-thread query");
  });

  it("keeps cleanup-only aborts out of unfinished native tool outcomes", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          client.emit({
            method: "item/started",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              item: nativeCommandItem("native-tool-unfinished", "inProgress", null),
            },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "Native tool answer."));
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "agent:side-agent:main",
          opts: { runId: "run-side-native-unfinished" },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(
      diagnosticEvents.filter(
        (event) =>
          event.type.startsWith("tool.execution.") &&
          "toolCallId" in event &&
          event.toolCallId === "native-tool-unfinished",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "tool.execution.started",
        toolCallId: "native-tool-unfinished",
      }),
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "native-tool-unfinished",
        errorCategory: "codex_native_tool_error",
        terminalReason: "failed",
      }),
    ]);
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
  });

  it("projects snapshot-only native side-thread tools exactly once", async () => {
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          const notification = turnCompleted("side-thread", "turn-1", "Snapshot answer.");
          const turn = (notification.params as JsonObject).turn as JsonObject;
          turn.items = [
            nativeCommandItem("snapshot-tool-1", "completed", 19),
            ...(turn.items as JsonValue[]),
          ];
          client.emit(notification);
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "agent:side-agent:main",
          opts: { runId: "run-side-snapshot-tool" },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(
      diagnosticEvents
        .filter((event) => event.type.startsWith("tool.execution."))
        .map((event) => ({
          type: event.type,
          toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
          durationMs: "durationMs" in event ? event.durationMs : undefined,
        })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolCallId: "snapshot-tool-1",
        durationMs: undefined,
      },
      {
        type: "tool.execution.completed",
        toolCallId: "snapshot-tool-1",
        durationMs: 19,
      },
    ]);
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
  });

  it("finalizes an active native side-thread tool when side completion times out", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          client.emit({
            method: "item/started",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              item: nativeCommandItem("native-tool-timeout", "inProgress", null),
            },
          });
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      const runResult = runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "agent:side-agent:main",
          opts: { runId: "run-side-native-timeout" },
        }),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600_000);

      await expect(runResult).resolves.toMatchObject({ name: "TimeoutError" });
      await vi.runAllTimersAsync();
      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          agentId: "side-agent",
          toolCallId: "native-tool-timeout",
          terminalReason: "timed_out",
        }),
      );
      expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("classifies an active side tool as timed out when side completion expires", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    toolExecuteMock.mockImplementation(
      (_callId: string, _args: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        }),
    );
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void client.handleRequest({
            id: 42,
            method: "item/tool/call",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              callId: "tool-timeout",
              tool: "wiki_status",
              arguments: {},
            },
          });
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      const runPromise = runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "global",
          opts: { runId: "run-side-timeout" },
        }),
      );
      const runResult = runPromise.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600_000);

      await expect(runResult).resolves.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          agentId: "side-agent",
          toolCallId: "tool-timeout",
          terminalReason: "timed_out",
        }),
      );
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("normalizes hook channel ids for side-thread dynamic tool requests", async () => {
    const beforeToolCall = vi.fn((...args: unknown[]) => {
      const context = args[1] as { channelId?: string };
      expect(context.channelId).toBe("voice-room");
      return undefined;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            await client.handleRequest({
              id: 42,
              method: "item/tool/call",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                callId: "tool-1",
                tool: "wiki_status",
                arguments: { topic: "AGENTS.md" },
              },
            });
            client.emit(agentDelta("side-thread", "turn-1", "Tool answer."));
            client.emit(turnCompleted("side-thread", "turn-1", "Tool answer."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          messageChannel: "discord",
          messageProvider: "discord-voice",
          currentChannelId: "discord:voice-room",
        }),
      ),
    ).resolves.toEqual({ text: "Tool answer." });

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ hookChannelId: "voice-room" }),
    );
    expect(toolExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty response for side-thread user input requests", async () => {
    const client = createFakeClient();
    let unrelatedUserInputResponse: unknown;
    let userInputResponse: unknown;
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(() => {
          void (async () => {
            unrelatedUserInputResponse = await client.handleRequest({
              id: 42,
              method: "item/tool/requestUserInput",
              params: {
                threadId: "parent-thread",
                turnId: "parent-turn",
                itemId: "input-parent",
                questions: [],
              },
            });
            userInputResponse = await client.handleRequest({
              id: 43,
              method: "item/tool/requestUserInput",
              params: {
                threadId: "side-thread",
                turnId: "turn-1",
                itemId: "input-1",
                questions: [
                  {
                    id: "choice",
                    header: "Choice",
                    question: "Pick one",
                    options: [{ label: "A", description: "" }],
                  },
                ],
              },
            });
            client.emit(turnCompleted("side-thread", "turn-1", "No input needed."));
          })();
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(sideParams());

    expect(result).toEqual({ text: "No input needed." });
    expect(unrelatedUserInputResponse).toBeUndefined();
    expect(userInputResponse).toEqual({ answers: {} });
  });

  it("cleans up notification handlers when side tool setup fails", async () => {
    const client = createFakeClient();
    createOpenClawCodingToolsMock.mockImplementation(() => {
      throw new Error("tool setup failed");
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow("tool setup failed");

    expect(client.notifications).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
  });

  it("uses the app-server auth refresh request handler while the side thread is active", async () => {
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        await client.requests[0]?.({
          id: 1,
          method: "account/chatgptAuthTokens/refresh",
        });
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => client.emit(turnCompleted("side-thread", "turn-1", "Done.")));
        return turnStartResult("turn-1");
      }
      return {};
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await runCodexAppServerSideQuestion(sideParams());

    expect(refreshCodexAppServerAuthTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/agent",
        authProfileId: "openai:work",
        authProfileStore: expect.any(Object),
        config: {},
      }),
    );
  });

  it("returns a clear setup error when there is no Codex parent thread", async () => {
    readCodexAppServerBindingMock.mockResolvedValue(undefined);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("returns the same setup error when the persisted parent binding is stale", async () => {
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        throw new Error("thread/fork failed: no rollout found for thread id parent-thread");
      }
      return {};
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
  });

  it("interrupts and unsubscribes the ephemeral thread on abort", async () => {
    const controller = new AbortController();
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => controller.abort());
        return turnStartResult("turn-1");
      }
      if (method === "turn/interrupt" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          opts: { abortSignal: controller.signal },
        }),
      ),
    ).rejects.toThrow("Codex /btw was aborted.");
    expect(client.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toEqual([
      ["turn/interrupt", { threadId: "side-thread", turnId: "turn-1" }, { timeoutMs: 60_000 }],
    ]);
    expect(client.request.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toEqual(
      [["thread/unsubscribe", { threadId: "side-thread" }, { timeoutMs: 60_000 }]],
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
