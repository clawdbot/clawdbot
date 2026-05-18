import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification, RpcRequest } from "./protocol.js";

const readCodexAppServerBindingMock = vi.fn();
const isCodexAppServerNativeAuthProfileMock = vi.fn();
const getSharedCodexAppServerClientMock = vi.fn();
const refreshCodexAppServerAuthTokensMock = vi.fn();
const createOpenClawCodingToolsMock = vi.fn();
const toolExecuteMock = vi.fn();
const handleCodexAppServerApprovalRequestMock = vi.fn();

vi.mock("./session-binding.js", () => ({
  clearCodexAppServerBinding: vi.fn(),
  isCodexAppServerNativeAuthProfile: (...args: unknown[]) =>
    isCodexAppServerNativeAuthProfileMock(...args),
  readCodexAppServerBinding: (...args: unknown[]) => readCodexAppServerBindingMock(...args),
  writeCodexAppServerBinding: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  getSharedCodexAppServerClient: (...args: unknown[]) => getSharedCodexAppServerClientMock(...args),
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: (...args: unknown[]) =>
    refreshCodexAppServerAuthTokensMock(...args),
}));

vi.mock("./approval-bridge.js", () => ({
  handleCodexAppServerApprovalRequest: (...args: unknown[]) =>
    handleCodexAppServerApprovalRequestMock(...args),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: (...args: unknown[]) => createOpenClawCodingToolsMock(...args),
}));

const { __testing, runCodexAppServerSideQuestion } = await import("./side-question.js");

type ServerRequest = Required<Pick<RpcRequest, "id" | "method">> & {
  params?: RpcRequest["params"];
};

type FakeClient = {
  request: ReturnType<typeof vi.fn>;
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
    request: vi.fn(),
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

function sideParams(overrides: Partial<Parameters<typeof runCodexAppServerSideQuestion>[0]> = {}) {
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
    authProfileId: "openai-codex:work",
    authProfileIdSource: "user",
    ...overrides,
  } satisfies Parameters<typeof runCodexAppServerSideQuestion>[0];
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
    ]);

    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai-codex:work",
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
    resetGlobalHookRunner();
  });

  it("forks an ephemeral side thread and returns the completed assistant text", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(
      sideParams({
        messageChannel: "discord",
        messageProvider: "discord-voice",
        currentChannelId: "voice-room",
      }),
    );

    expect(result).toEqual({ text: "Side answer." });
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
    expect(forkParams?.approvalPolicy).toBe("on-request");
    expect(forkParams?.sandbox).toBe("workspace-write");
    expect(forkParams?.ephemeral).toBe(true);
    expect(forkParams?.threadSource).toBe("user");
    expect(forkParams?.approvalsReviewer).toBe("user");
    expect(forkParams?.cwd).toBe("/tmp/workspace");
    expect(forkParams?.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
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
    expect(toolOptions).toHaveProperty("messageProvider", "discord-voice");
    expect(toolOptions).toHaveProperty("currentChannelId", "voice-room");
    expect(toolOptions).toHaveProperty("requireExplicitMessageTarget", true);
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
    expect(config?.["features.code_mode_only"]).toBe(true);
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
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
    ).toBeUndefined();
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
        setTimeout(async () => {
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
      runCodexAppServerSideQuestion(sideParams(), { nativeHookRelay: { enabled: true } }),
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
      authProfileId: "openai-codex:work",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), { nativeHookRelay: { enabled: true } }),
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
      "features.code_mode_only": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
    expect(config).not.toHaveProperty("hooks.state");
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
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: {
          appServer: {
            requestTimeoutMs,
            turnCompletionIdleTimeoutMs: completionTimeoutMs,
          },
        },
        nativeHookRelay: { enabled: true },
      }),
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
        setTimeout(async () => {
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
        setTimeout(async () => {
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
        setTimeout(async () => {
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

  it("uses configured image generation timeout for side-thread image_generate calls", () => {
    const timeoutMs = __testing.resolveSideDynamicToolCallTimeoutMs({
      call: {
        threadId: "side-thread",
        turnId: "turn-1",
        callId: "tool-1",
        tool: "image_generate",
      },
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              timeoutMs: 123_456,
            },
          },
        },
      } as never,
    });

    expect(timeoutMs).toBe(123_456);
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

    expect(refreshCodexAppServerAuthTokensMock).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      authProfileId: "openai-codex:work",
      config: {},
    });
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
