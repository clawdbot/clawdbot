// Codex tests cover conversation binding plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import type { PluginConversationBinding } from "openclaw/plugin-sdk/plugin-entry";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
  retainSharedCodexAppServerClientByInstanceId: vi.fn(
    (_clientId?: string): { client: unknown; release: () => void } | undefined => undefined,
  ),
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed: vi.fn((_client: unknown) => ({
    found: false,
    closed: false,
  })),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(
    (_client: unknown): { activeLeases: number; closed: boolean } | undefined => undefined,
  ),
  clearSharedCodexAppServerClientIfCurrent: vi.fn((_client: unknown) => false),
}));

const publicBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn((_conversation: unknown): { bindingId: string } | null => ({
    bindingId: "binding-1",
  })),
}));

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/agent/workspace"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIdsStrict: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
}));

const providerAuthMocks = vi.hoisted(() => ({
  resolveAuthProfileOrder: vi.fn(),
}));

const codexRequirementsTomlMock = vi.hoisted(() => vi.fn<() => string | undefined>());
const resolveSandboxContextMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ enabled: boolean } | null>>(async () => null),
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(filePath: string | URL | number, options?: BufferEncoding | object | null) {
      if (filePath === "/etc/codex/requirements.toml") {
        const content = codexRequirementsTomlMock();
        if (content !== undefined) {
          return content;
        }
      }
      return actual.readFileSync(filePath, options);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    resolveSandboxContext: resolveSandboxContextMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>();
  return {
    ...actual,
    getSessionBindingService: () => ({
      resolveByConversation: publicBindingMocks.resolveByConversation,
    }),
  };
});

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  isCodexAppServerStartSelectionChangedError: (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_START_SELECTION_CHANGED",
  getLeasedSharedCodexAppServerClient: async (...args: unknown[]) => {
    const client = (await sharedClientMocks.getSharedCodexAppServerClient(...args)) as {
      getInstanceId?: () => string;
      addCloseHandler?: () => () => void;
    };
    client.getInstanceId ??= () => "test-client";
    client.addCloseHandler ??= () => () => undefined;
    return client;
  },
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withLeasedCodexAppServerClientStartSelectionRetry: async (params: {
    lease: { client?: unknown };
    options?: { timeoutMs?: number };
    run: (
      client: unknown,
      requestOptions: () => { timeoutMs: number; assertCurrent: () => void },
    ) => Promise<unknown>;
  }) =>
    await params.run(params.lease.client, () => ({
      timeoutMs: params.options?.timeoutMs ?? 60_000,
      assertCurrent: () => undefined,
    })),
}));
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovals: execApprovalsRuntimeMocks.loadExecApprovals,
  };
});
vi.mock("openclaw/plugin-sdk/agent-runtime", () => agentRuntimeMocks);
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  resolveAuthProfileOrder: providerAuthMocks.resolveAuthProfileOrder,
}));
vi.mock("openclaw/plugin-sdk/agent-scope-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-scope-runtime")>()),
  resolveSessionAgentIdsStrict: agentRuntimeMocks.resolveSessionAgentIdsStrict,
}));

import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { codexNativeSubagentMonitorRuntime } from "./app-server/native-subagent-monitor.js";
import type { JsonValue } from "./app-server/protocol.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import { withCodexConversationThreadActivity } from "./app-server/thread-ownership.js";
import { getCodexAppServerTurnRouter } from "./app-server/turn-router.js";
import { legacyCodexConversationBindingId } from "./conversation-binding-data.js";
import { codexConversationBindingRuntime } from "./conversation-binding.js";
import { readCodexConversationActiveTurn } from "./conversation-control.js";

const handleCodexConversationBindingResolvedImpl =
  codexConversationBindingRuntime.handleBindingResolved;
const handleCodexConversationInboundClaimImpl = codexConversationBindingRuntime.handleInboundClaim;
const startCodexConversationThreadImpl = codexConversationBindingRuntime.startThread;

function testConversationIdentity(sessionFile: string) {
  return {
    kind: "conversation" as const,
    bindingId: legacyCodexConversationBindingId(sessionFile),
  };
}

async function writeTestConversationBinding(
  sessionFile: string,
  binding: CodexAppServerThreadBinding,
): Promise<void> {
  await testCodexAppServerBindingStore.mutate(testConversationIdentity(sessionFile), {
    kind: "set",
    binding: { clientId: "test-client", ...binding },
  });
}

async function readTestConversationBinding(sessionFile: string) {
  return testCodexAppServerBindingStore.read(testConversationIdentity(sessionFile));
}

function boundConversationClaim(sessionFile: string, sessionKey?: string) {
  const pluginBinding: PluginConversationBinding = {
    bindingId: "binding-1",
    pluginId: "codex",
    pluginRoot: tempDir,
    channel: "telegram",
    accountId: "default",
    conversationId: "5185575566",
    boundAt: Date.now(),
    data: {
      kind: "codex-app-server-session" as const,
      version: 1 as const,
      sessionFile,
      workspaceDir: tempDir,
    },
  };
  return {
    event: {
      content: "continue",
      bodyForAgent: "continue",
      channel: "telegram",
      isGroup: false,
      commandAuthorized: true,
      ...(sessionKey ? { sessionKey } : {}),
    },
    ctx: {
      channelId: "telegram",
      ...(sessionKey ? { sessionKey } : {}),
      pluginBinding,
    },
  };
}

async function createSameThreadClientMigrationFixture(
  sessionFile: string,
  options: { rejectOldRelease: boolean; owner: "session" | "conversation" },
) {
  const binding = {
    threadId: "thread-migrated",
    clientId: "client-before-migration",
    cwd: tempDir,
  };
  const readOwner =
    options.owner === "session"
      ? async () => readCodexAppServerBinding(sessionFile)
      : async () => readTestConversationBinding(sessionFile);
  if (options.owner === "session") {
    await writeCodexAppServerBinding(sessionFile, binding);
  } else {
    await writeTestConversationBinding(sessionFile, binding);
  }
  const operations: string[] = [];
  const ownerDuringRelease: Array<string | undefined> = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const previousClient = {
    getInstanceId: () => "client-before-migration",
    request: vi.fn(async (method: string) => {
      operations.push(`previous:${method}`);
      ownerDuringRelease.push((await readOwner())?.clientId);
      if (options.rejectOldRelease) {
        throw new Error("previous physical client unsubscribe failed");
      }
      return {};
    }),
    addNotificationHandler: vi.fn(() => () => undefined),
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn(() => () => undefined),
  } as unknown as CodexAppServerClient;
  const replacementClient = {
    getInstanceId: () => "client-after-migration",
    request: vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: conversationThreadStartResult("thread-migrated").thread };
      }
      operations.push(`replacement:${method}`);
      if (method === "thread/resume") {
        return conversationThreadStartResult("thread-migrated");
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/completed",
              params: {
                threadId: "thread-migrated",
                turn: {
                  id: "turn-migrated",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "answer", text: "Migrated reply" }],
                },
              },
            });
          }
        });
        return { turn: { id: "turn-migrated" } };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
    addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    }),
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn(() => () => undefined),
  } as unknown as CodexAppServerClient;
  ensureCodexAppServerClientRuntime(previousClient, { agentDir: tempDir });
  ensureCodexAppServerClientRuntime(replacementClient, { agentDir: tempDir });
  await expect(retainCodexAppServerLiveThread(previousClient, "thread-migrated")).resolves.toBe(
    true,
  );
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(replacementClient);
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockImplementation((clientId) =>
    clientId === previousClient.getInstanceId()
      ? { client: previousClient, release: vi.fn() }
      : undefined,
  );
  return { previousClient, replacementClient, operations, ownerDuringRelease, readOwner };
}

function handleCodexConversationInboundClaim(
  event: Parameters<typeof handleCodexConversationInboundClaimImpl>[0],
  ctx: Parameters<typeof handleCodexConversationInboundClaimImpl>[1],
  options: Omit<Parameters<typeof handleCodexConversationInboundClaimImpl>[2], "bindingStore"> = {},
) {
  return handleCodexConversationInboundClaimImpl({ senderIsOwner: true, ...event }, ctx, {
    ...options,
    bindingStore: testCodexAppServerBindingStore,
  });
}

function startCodexConversationThread(
  params: Omit<Parameters<typeof startCodexConversationThreadImpl>[0], "bindingStore">,
) {
  return startCodexConversationThreadImpl({
    ...params,
    bindingStore: testCodexAppServerBindingStore,
  });
}

function handleCodexConversationBindingResolved(
  event: Parameters<typeof handleCodexConversationBindingResolvedImpl>[0],
) {
  return handleCodexConversationBindingResolvedImpl(event, {
    bindingStore: testCodexAppServerBindingStore,
  });
}

let tempDir: string;

const NETWORK_PROXY_PLUGIN_CONFIG = {
  appServer: {
    networkProxy: {
      enabled: true,
      domains: { "api.openai.com": "allow" },
      allowUpstreamProxy: true,
      proxyUrl: "http://127.0.0.1:3128",
    },
  },
};
const NETWORK_PROXY_RUNTIME = resolveCodexAppServerRuntimeOptions({
  env: {},
  requirementsToml: null,
  pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
});
const NETWORK_PROXY_PROFILE_NAME = NETWORK_PROXY_RUNTIME.networkProxy?.profileName ?? "missing";
const NETWORK_PROXY_CONFIG_PATCH = NETWORK_PROXY_RUNTIME.networkProxy?.configPatch ?? {};
const NETWORK_PROXY_CONFIG_FINGERPRINT =
  NETWORK_PROXY_RUNTIME.networkProxy?.configFingerprint ?? "missing";

function conversationThreadStartResult(threadId: string, canAcceptDirectInput?: boolean | null) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: tempDir,
    model: "gpt-5.4-mini",
    modelProvider: "openai",
    sandbox: { type: "workspaceWrite", networkAccess: false },
    serviceTier: null,
    activePermissionProfile: null,
    thread: {
      id: threadId,
      sessionId: "session-1",
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir,
      projectId: null,
      cliVersion: "0.149.0",
      source: "unknown",
      ...(canAcceptDirectInput !== undefined ? { canAcceptDirectInput } : {}),
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
  };
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("codex conversation binding", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    publicBindingMocks.resolveByConversation.mockReset();
    publicBindingMocks.resolveByConversation.mockReturnValue({ bindingId: "binding-1" });
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReset();
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue(undefined);
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed.mockReset();
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed.mockReturnValue({
      found: false,
      closed: false,
    });
    sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReset();
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrent.mockReset();
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrent.mockReturnValue(false);
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    agentRuntimeMocks.ensureAuthProfileStore.mockReset();
    agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
    providerAuthMocks.resolveAuthProfileOrder.mockReset();
    agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.resolveSessionAgentIdsStrict.mockClear();
    agentRuntimeMocks.saveAuthProfileStore.mockReset();
    codexRequirementsTomlMock.mockReset();
    resolveSandboxContextMock.mockReset();
    resolveSandboxContextMock.mockResolvedValue(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    providerAuthMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation(
      (provider: string, _lookup?: { config?: unknown }) => provider,
    );
    agentRuntimeMocks.resolveSessionAgentIdsStrict.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
  });

  it("isolates concurrent turn requests and buffers early bound-turn completion", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "bound-thread", cwd: tempDir });
    const notificationHandlers = new Set<(notification: unknown) => unknown>();
    const requestHandlers = new Set<(request: unknown) => unknown>();
    const siblingRequestOwner = vi.fn((request: { method: string }): JsonValue =>
      request.method === "item/tool/call"
        ? { contentItems: [], success: true }
        : { decision: "accept" },
    );
    const siblingResponses: unknown[] = [];
    let releaseSiblingRoute: (() => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        const siblingRoute = getCodexAppServerTurnRouter(clientForRouter).reserveThread({
          threadId: "sibling-thread",
          onRequest: siblingRequestOwner,
        });
        releaseSiblingRoute = siblingRoute.release;
        siblingRoute.armTurn();
        await siblingRoute.bindTurn("sibling-turn");
        for (const requestMethod of ["item/tool/call", "item/commandExecution/requestApproval"]) {
          const request = {
            id: requestMethod,
            method: requestMethod,
            params: { threadId: "sibling-thread", turnId: "sibling-turn" },
          };
          for (const handler of requestHandlers) {
            const response = await handler(request);
            if (response !== undefined) {
              siblingResponses.push(response);
              break;
            }
          }
        }
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: {
              threadId: "bound-thread",
              turn: {
                id: "bound-turn",
                status: "completed",
                items: [{ type: "agentMessage", id: "bound-answer", text: "Bound answer" }],
              },
            },
          });
        }
        return { turn: { id: "bound-turn" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => unknown) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      }),
      addRequestHandler: vi.fn((handler: (request: unknown) => unknown) => {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      }),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    const clientForRouter = client as never;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    const { event, ctx } = boundConversationClaim(sessionFile);

    try {
      await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
        handled: true,
        reply: { text: "Bound answer" },
      });
      expect(siblingRequestOwner).toHaveBeenCalledTimes(2);
      expect(siblingResponses).toEqual([
        { contentItems: [], success: true },
        { decision: "accept" },
      ]);
      expect(client.addNotificationHandler).toHaveBeenCalledOnce();
      expect(client.addRequestHandler).toHaveBeenCalledOnce();
    } finally {
      releaseSiblingRoute?.();
    }
  });

  it("keeps queued bound turns ahead of retirement on their shared owner lane", async () => {
    const sessionFile = path.join(tempDir, "queued-session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "bound-thread", cwd: tempDir });
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const order: string[] = [];
    const client = {
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        const turnId = `turn-${order.filter((entry) => entry.startsWith("turn-")).length + 1}`;
        order.push(turnId);
        return { turn: { id: turnId } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    const { event, ctx } = boundConversationClaim(sessionFile);
    const completeTurn = (turnId: string) => {
      for (const handler of notificationHandlers) {
        handler({
          method: "turn/completed",
          params: {
            threadId: "bound-thread",
            turn: {
              id: turnId,
              status: "completed",
              items: [{ type: "agentMessage", id: `${turnId}-answer`, text: turnId }],
            },
          },
        });
      }
    };

    const firstTurn = handleCodexConversationInboundClaim(event, ctx);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    const secondTurn = handleCodexConversationInboundClaim(event, ctx);
    const retirement = withCodexConversationThreadActivity(
      legacyCodexConversationBindingId(sessionFile),
      async () => {
        order.push("retired");
      },
    );

    completeTurn("turn-1");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["turn-1", "turn-2"]);
    completeTurn("turn-2");

    await expect(firstTurn).resolves.toMatchObject({ reply: { text: "turn-1" } });
    await expect(secondTurn).resolves.toMatchObject({ reply: { text: "turn-2" } });
    await retirement;
    expect(order).toEqual(["turn-1", "turn-2", "retired"]);
  });

  it.each(["detached", "replaced", "cleared-before-capture"] as const)(
    "does not recreate a %s conversation from an inbound claim queued behind retirement",
    async (outcome) => {
      const bindingId = "binding-retiring";
      const identity = { kind: "conversation" as const, bindingId };
      if (outcome === "detached" || outcome === "cleared-before-capture") {
        await testCodexAppServerBindingStore.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-retiring",
            cwd: tempDir,
            conversationStartId: "start-original",
          },
        });
      }
      let retireConversation: (() => void) | undefined;
      const retirementReady = new Promise<void>((resolve) => {
        retireConversation = resolve;
      });
      let retirementStarted: (() => void) | undefined;
      const enteredRetirement = new Promise<void>((resolve) => {
        retirementStarted = resolve;
      });
      const retirement = withCodexConversationThreadActivity(bindingId, async () => {
        if (outcome === "cleared-before-capture") {
          await testCodexAppServerBindingStore.mutate(identity, {
            kind: "clear",
            threadId: "thread-retiring",
          });
        }
        retirementStarted?.();
        await retirementReady;
        if (outcome === "detached") {
          await testCodexAppServerBindingStore.mutate(identity, {
            kind: "clear",
            threadId: "thread-retiring",
          });
        } else if (outcome === "replaced") {
          await testCodexAppServerBindingStore.mutate(identity, {
            kind: "set",
            binding: {
              threadId: "thread-replacement",
              cwd: tempDir,
              conversationStartId: "start-replacement",
            },
          });
        }
        publicBindingMocks.resolveByConversation.mockReturnValue(
          outcome === "replaced" ? { bindingId: "binding-replacement" } : null,
        );
      });
      await enteredRetirement;
      let capturedOwner: (() => void) | undefined;
      const ownerCaptured = new Promise<void>((resolve) => {
        capturedOwner = resolve;
      });
      const bindingStore = {
        ...testCodexAppServerBindingStore,
        read: (requestedIdentity: Parameters<typeof testCodexAppServerBindingStore.read>[0]) => {
          const binding = testCodexAppServerBindingStore.read(requestedIdentity);
          capturedOwner?.();
          return binding;
        },
      };
      const { event, ctx } = boundConversationClaim(path.join(tempDir, "retiring-session.jsonl"));
      ctx.pluginBinding.data = {
        kind: "codex-app-server-session" as const,
        version: 2 as const,
        bindingId,
        workspaceDir: tempDir,
        start: { id: "start-original" },
      };
      const queued = handleCodexConversationInboundClaimImpl(
        { senderIsOwner: true, ...event },
        ctx,
        {
          bindingStore,
        },
      );
      await ownerCaptured;

      retireConversation?.();

      await retirement;
      await expect(queued).resolves.toEqual({
        handled: true,
        reply: {
          text: "This Codex conversation was detached or changed before its message could run.",
        },
      });
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
      if (outcome !== "replaced") {
        expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
      } else {
        expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
          threadId: "thread-replacement",
        });
      }
    },
  );

  it("uses the default Codex auth profile and omits the public OpenAI provider for new binds", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionKey = "agent:main:dashboard:incognito-native-bind";
    registerCodexTestSessionIdentity(sessionFile, sessionFile, sessionKey);
    const config = {
      auth: { order: { openai: ["openai:default"] } },
    };
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    providerAuthMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await startCodexConversationThread({
      config: config as never,
      sessionFile,
      sessionKey,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    const authOrderParams = mockCallArg(providerAuthMocks.resolveAuthProfileOrder) as {
      cfg?: unknown;
      provider?: unknown;
    };
    expect(authOrderParams?.cfg).toBe(config);
    expect(authOrderParams?.provider).toBe("openai");
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("openai:default");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[0]?.params.personality).toBe("none");
    expect(requests[0]?.params.ephemeral).toBe(true);
    expect(requests[0]?.params.config).toMatchObject({ project_doc_max_bytes: 131_072 });
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      authProfileId: "openai:default",
    });
  });

  it.each([
    {
      label: "an incognito source bound to an ordinary destination",
      sourceSessionKey: "agent:main:dashboard:incognito-source",
      destinationSessionKey: "agent:main:telegram:ordinary-destination",
      ephemeral: true,
      turnFails: false,
    },
    {
      label: "an ordinary source bound to an incognito destination",
      sourceSessionKey: "agent:main:telegram:ordinary-source",
      destinationSessionKey: "agent:main:dashboard:incognito-destination",
      ephemeral: false,
      turnFails: false,
    },
    {
      label: "a source without a session key bound to an incognito destination",
      sourceSessionKey: undefined,
      destinationSessionKey: "agent:main:dashboard:incognito-destination",
      ephemeral: false,
      turnFails: false,
    },
    {
      label: "a failing incognito source bound to an ordinary destination",
      sourceSessionKey: "agent:main:dashboard:incognito-source",
      destinationSessionKey: "agent:main:telegram:ordinary-destination",
      ephemeral: true,
      turnFails: true,
    },
    {
      label: "a failing ordinary source bound to an incognito destination",
      sourceSessionKey: "agent:main:telegram:ordinary-source",
      destinationSessionKey: "agent:main:dashboard:incognito-destination",
      ephemeral: false,
      turnFails: true,
    },
  ])(
    "uses the persisted source lifecycle for $label",
    async ({ sourceSessionKey, destinationSessionKey, ephemeral, turnFails }) => {
      const sessionFile = path.join(tempDir, "mixed-source-lifecycle.jsonl");
      const bindingId = "binding-mixed-source-lifecycle";
      const storePath = path.join(tempDir, "mixed-source-lifecycle.sqlite");
      await upsertSessionEntry({
        agentId: "main",
        sessionKey: sourceSessionKey ?? "agent:main:source-without-key",
        storePath,
        entry: { sessionId: "source-mixed-lifecycle", updatedAt: Date.now() },
      });
      const operations: Array<{ method: string; params: Record<string, unknown> }> = [];
      const notificationHandlers = new Set<(notification: unknown) => void>();
      const client = {
        getInstanceId: () => "client-mixed-source-lifecycle",
        request: vi.fn(async (method: string, params: Record<string, unknown>) => {
          operations.push({ method, params });
          if (method === "thread/start") {
            return conversationThreadStartResult("thread-mixed-source-lifecycle");
          }
          if (method === "turn/start") {
            if (turnFails) {
              throw new Error("mixed source lifecycle turn failed");
            }
            queueMicrotask(() => {
              for (const handler of notificationHandlers) {
                handler({
                  method: "turn/completed",
                  params: {
                    threadId: "thread-mixed-source-lifecycle",
                    turn: {
                      id: "turn-mixed-source-lifecycle",
                      status: "completed",
                      items: [{ type: "agentMessage", id: "answer", text: "Bound reply" }],
                    },
                  },
                });
              }
            });
            return { turn: { id: "turn-mixed-source-lifecycle" } };
          }
          if (method === "thread/unsubscribe") {
            return {};
          }
          throw new Error(`unexpected method: ${method}`);
        }),
        addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        }),
        addRequestHandler: vi.fn(() => () => undefined),
        addCloseHandler: vi.fn(() => () => undefined),
      } as unknown as CodexAppServerClient;
      ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
      sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
        client,
        release: vi.fn(),
      });
      const { event, ctx } = boundConversationClaim(sessionFile, destinationSessionKey);
      const data = {
        kind: "codex-app-server-session" as const,
        version: 2 as const,
        bindingId,
        workspaceDir: tempDir,
        source: {
          agentId: "main",
          sessionId: "source-mixed-lifecycle",
          threadId: "thread-source-mixed-lifecycle",
          ...(sourceSessionKey ? { sessionKey: sourceSessionKey } : {}),
        },
        start: { id: "start-mixed-source-lifecycle" },
      };
      ctx.pluginBinding.data = data;

      await expect(
        handleCodexConversationInboundClaim(event, ctx, {
          config: { session: { store: storePath } },
        }),
      ).resolves.toMatchObject({
        handled: true,
        reply: {
          text: turnFails
            ? "Codex app-server turn failed: mixed source lifecycle turn failed"
            : "Bound reply",
        },
      });

      expect(operations.map(({ method }) => method)).toEqual(
        turnFails
          ? ["thread/start", "turn/start", "thread/unsubscribe"]
          : ["thread/start", "turn/start"],
      );
      if (ephemeral) {
        expect(operations[0]?.params.ephemeral).toBe(true);
        await expect(
          consumeCodexAppServerLiveThread(client, "thread-mixed-source-lifecycle"),
        ).resolves.toBeUndefined();
      } else {
        expect(operations[0]?.params).not.toHaveProperty("ephemeral");
        if (turnFails) {
          await expect(
            consumeCodexAppServerLiveThread(client, "thread-mixed-source-lifecycle"),
          ).resolves.toBeUndefined();
        } else {
          const ownership = await consumeCodexAppServerLiveThread(
            client,
            "thread-mixed-source-lifecycle",
          );
          expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
          await expect(
            retainCodexAppServerLiveThread(
              client,
              "thread-mixed-source-lifecycle",
              ownership?.release,
              ownership?.configFingerprint,
              ownership?.serviceTier,
            ),
          ).resolves.toBe(true);
        }
      }

      if (turnFails && ephemeral) {
        expect(
          testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
        ).toBeUndefined();
        return;
      }

      await handleCodexConversationBindingResolved({
        status: "denied",
        decision: "deny",
        request: {
          data,
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
          },
        },
      });

      expect(operations.at(-1)).toEqual({
        method: "thread/unsubscribe",
        params: { threadId: "thread-mixed-source-lifecycle" },
      });
      expect(
        testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
      ).toBeUndefined();
    },
  );

  it.each(["missing", "rebound"] as const)(
    "fails closed before client startup when the source session is %s",
    async (sourceState) => {
      const bindingId = `binding-${sourceState}-source`;
      const sessionFile = path.join(tempDir, `${sourceState}-source.jsonl`);
      const storePath = path.join(tempDir, `${sourceState}-source.sqlite`);
      const source = {
        agentId: "main",
        sessionId: "source-session",
        sessionKey: "agent:main:source-session",
        threadId: "thread-source",
      };
      if (sourceState === "rebound") {
        await upsertSessionEntry({
          agentId: source.agentId,
          sessionKey: source.sessionKey,
          storePath,
          entry: { sessionId: "replacement-session", updatedAt: Date.now() },
        });
      }
      await testCodexAppServerBindingStore.mutate(
        { kind: "conversation", bindingId },
        { kind: "set", binding: { threadId: "thread-bound", cwd: tempDir } },
      );
      const { event, ctx } = boundConversationClaim(sessionFile);
      ctx.pluginBinding.data = {
        kind: "codex-app-server-session",
        version: 2,
        bindingId,
        workspaceDir: tempDir,
        source,
      };
      sharedClientMocks.getSharedCodexAppServerClient.mockRejectedValue(
        new Error("Codex client must not start"),
      );

      await expect(
        handleCodexConversationInboundClaim(event, ctx, {
          config: { session: { store: storePath } },
        }),
      ).resolves.toMatchObject({
        handled: true,
        reply: {
          text: expect.stringContaining("source session is missing or no longer current"),
        },
      });
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    },
  );

  it("selects Codex network-proxy permissions through app-server bind thread config", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await startCodexConversationThread({
      pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
      sessionFile,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params).not.toHaveProperty("permissions");
    expect(requests[0]?.params).not.toHaveProperty("sandbox");
    expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
  });

  it("starts a fresh proxy-backed thread when binding an explicit app-server thread id", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "thread/resume") {
          throw new Error("thread/resume should not receive network proxy config");
        }
        return conversationThreadStartResult("thread-new");
      }),
    });

    await startCodexConversationThread({
      pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
      sessionFile,
      threadId: "thread-old",
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    expect(requests.map((request) => request.method)).toEqual(["thread/start"]);
    expect(requests[0]?.params).not.toHaveProperty("threadId");
    expect(requests[0]?.params).not.toHaveProperty("sandbox");
    expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
    const bindingAfterStart = await readCodexAppServerBinding(sessionFile);
    expect(bindingAfterStart?.threadId).toBe("thread-new");
    expect(bindingAfterStart?.networkProxyProfileName).toBe(NETWORK_PROXY_PROFILE_NAME);
    expect(bindingAfterStart?.networkProxyConfigFingerprint).toBe(NETWORK_PROXY_CONFIG_FINGERPRINT);
  });

  it("releases a structured initial-attach resume failure before reusing the client", async () => {
    const sessionFile = path.join(tempDir, "structured-resume-failure.jsonl");
    const rejection = new CodexAppServerRpcError(
      { code: -32_603, message: "resume response assembly failed" },
      "thread/resume",
    );
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: conversationThreadStartResult("thread-structured-resume-failure").thread };
      }
      if (method === "thread/resume") {
        throw rejection;
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-structured-resume-failure",
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    } as unknown as CodexAppServerClient;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    await expect(
      startCodexConversationThread({
        sessionFile,
        threadId: "thread-structured-resume-failure",
        workspaceDir: tempDir,
      }),
    ).rejects.toBe(rejection);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
    ]);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it.each([undefined, null, true])(
    "reconfigures a retained interactive or unknown-capability thread (%s)",
    async (canAcceptDirectInput) => {
      const sessionFile = path.join(tempDir, "retained-child-session.jsonl");
      const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      const client = {
        getInstanceId: () => "client-native-child",
        request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
          if (method === "thread/read") {
            return {
              thread: conversationThreadStartResult("thread-native-child", canAcceptDirectInput)
                .thread,
            };
          }
          requests.push({ method, params: requestParams });
          if (method === "thread/unsubscribe") {
            return {};
          }
          if (method === "thread/resume") {
            return conversationThreadStartResult("thread-native-child", canAcceptDirectInput);
          }
          throw new Error(`unexpected method: ${method}`);
        }),
        addNotificationHandler: vi.fn(() => () => undefined),
        addRequestHandler: vi.fn(() => () => undefined),
        addCloseHandler: vi.fn(() => () => undefined),
      } as unknown as CodexAppServerClient;
      ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
      await retainCodexAppServerLiveThread(client, "thread-native-child");
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

      await startCodexConversationThread({
        pluginConfig: { appServer: { sandbox: "read-only" } },
        sessionFile,
        threadId: "thread-native-child",
        workspaceDir: tempDir,
      });

      expect(requests.map(({ method }) => method)).toEqual(["thread/unsubscribe", "thread/resume"]);
      expect(requests[0]?.params).toEqual({ threadId: "thread-native-child" });
      expect(requests[1]?.params).toMatchObject({
        threadId: "thread-native-child",
        sandbox: "read-only",
        config: {
          project_doc_max_bytes: 131_072,
          apps: { _default: { enabled: false } },
          "features.apps": false,
        },
      });
      await expect(consumeCodexAppServerLiveThread(client, "thread-native-child")).resolves.toEqual(
        expect.objectContaining({ release: expect.any(Function) }),
      );
    },
  );

  it.each(["preflight", "commit", "retention", "binding-read"] as const)(
    "preserves the current owner when attachment fails during %s",
    async (expiresDuring) => {
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const actualSharedClientRuntime = await vi.importActual<
        typeof import("./app-server/shared-client.js")
      >("./app-server/shared-client.js");
      const retry = vi
        .spyOn(sharedClientRuntime, "withLeasedCodexAppServerClientStartSelectionRetry")
        .mockImplementation(
          actualSharedClientRuntime.withLeasedCodexAppServerClientStartSelectionRetry,
        );
      const sessionFile = path.join(tempDir, "expired-attachment.jsonl");
      const threadId = "thread-expired-attachment";
      const existingThreadId = expiresDuring === "commit" ? "thread-previous-attachment" : threadId;
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
      const release = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(harness.client, existingThreadId, release);
      const releaseSibling = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(harness.client, "thread-sibling", releaseSibling);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: existingThreadId,
        clientId: harness.client.getInstanceId(),
        cwd: tempDir,
      });
      const before = await readCodexAppServerBinding(sessionFile);
      const response = conversationThreadStartResult(threadId, true);
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
      sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
        client: harness.client,
        release: vi.fn(),
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = Date.now();
      let resumeAccepted = false;
      const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
        if (method === "thread/read") {
          if (expiresDuring === "preflight") {
            vi.setSystemTime(startedAt + 1_001);
          }
          return { thread: response.thread } as never;
        }
        if (method === "thread/resume") {
          resumeAccepted = true;
          return response as never;
        }
        if (method === "thread/unsubscribe") {
          return {} as never;
        }
        throw new Error(`unexpected Codex method ${method}`);
      });

      try {
        await expect(
          startCodexConversationThreadImpl({
            pluginConfig: { appServer: { requestTimeoutMs: 1_000 } },
            sessionFile,
            threadId,
            workspaceDir: tempDir,
            bindingStore: {
              ...testCodexAppServerBindingStore,
              read: (identity) => {
                if (resumeAccepted) {
                  if (expiresDuring === "binding-read") {
                    throw new Error("Invalid Codex app-server binding row");
                  }
                  if (expiresDuring === "retention") {
                    vi.setSystemTime(startedAt + 1_001);
                  }
                }
                return testCodexAppServerBindingStore.read(identity);
              },
              mutate: async (...args) => {
                if (expiresDuring === "commit") {
                  vi.setSystemTime(startedAt + 1_001);
                }
                return await testCodexAppServerBindingStore.mutate(...args);
              },
            },
          }),
        ).rejects.toThrow(
          expiresDuring === "binding-read" ? "Invalid Codex app-server binding row" : "timed out",
        );

        expect(request.mock.calls.map(([method]) => method)).toEqual(
          expiresDuring === "preflight"
            ? ["thread/read"]
            : ["thread/read", "thread/resume", "thread/unsubscribe"],
        );
        expect(release).toHaveBeenCalledTimes(expiresDuring === "preflight" ? 0 : 1);
        expect(releaseSibling).not.toHaveBeenCalled();
        expect(harness.stdinDestroyed).toBe(false);
        await expect(
          consumeCodexAppServerLiveThread(harness.client, "thread-sibling"),
        ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
        await expect(consumeCodexAppServerLiveThread(harness.client, threadId)).resolves.toEqual(
          expiresDuring === "preflight"
            ? expect.objectContaining({ release: expect.any(Function) })
            : undefined,
        );
      } finally {
        retry.mockRestore();
        harness.client.close();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { knownBeforeResume: true, sameOwner: false },
    { knownBeforeResume: true, sameOwner: true },
    { knownBeforeResume: false, sameOwner: false },
  ])(
    "rejects binding a parent-owned child without displacing the current owner (preflight: $knownBeforeResume, same owner: $sameOwner)",
    async ({ knownBeforeResume, sameOwner }) => {
      const sessionFile = path.join(tempDir, "parent-owned-session.jsonl");
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
      const threadId = "thread-parent-owned";
      const existingThreadId = sameOwner ? threadId : "thread-existing";
      const release = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(harness.client, existingThreadId, release);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: existingThreadId,
        clientId: harness.client.getInstanceId(),
        cwd: tempDir,
      });
      const before = await readCodexAppServerBinding(sessionFile);
      const response = conversationThreadStartResult(threadId, false);
      const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
        if (method === "thread/read") {
          return {
            thread: { ...response.thread, canAcceptDirectInput: knownBeforeResume ? false : null },
          } as never;
        }
        if (method === "thread/resume") {
          return response as never;
        }
        if (method === "thread/unsubscribe") {
          return {} as never;
        }
        throw new Error(`unexpected Codex method ${method}`);
      });
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
      sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
        client: harness.client,
        release: vi.fn(),
      });

      try {
        await expect(
          startCodexConversationThread({ sessionFile, threadId, workspaceDir: tempDir }),
        ).rejects.toThrow("controlled by its parent");

        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
        expect(release).not.toHaveBeenCalled();
        expect(
          request.mock.calls.map(([method]) => method).filter((method) => method !== "thread/read"),
        ).toEqual(knownBeforeResume ? [] : ["thread/resume", "thread/unsubscribe"]);
        await expect(
          consumeCodexAppServerLiveThread(harness.client, existingThreadId),
        ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
      } finally {
        harness.client.close();
      }
    },
  );

  it("never resumes or unsubscribes an actively claimed native child for a conversation", async () => {
    const sessionFile = path.join(tempDir, "active-child-session.jsonl");
    const harness = createClientHarness();
    const request = vi
      .spyOn(harness.client, "request")
      .mockResolvedValue(conversationThreadStartResult("thread-active-child") as never);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const parent = codexNativeSubagentMonitorRuntime.register({
      client: harness.client,
      parentThreadId: "thread-parent",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);

    try {
      harness.send({
        method: "thread/started",
        params: {
          thread: {
            id: "thread-active-child",
            parentThreadId: "thread-parent",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "thread-parent",
                  depth: 1,
                  agent_path: "thread-active-child",
                },
              },
            },
          },
        },
      });
      await vi.waitFor(() =>
        expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-active-child")).toBe(true),
      );

      await expect(
        startCodexConversationThread({
          sessionFile,
          threadId: "thread-active-child",
          workspaceDir: tempDir,
        }),
      ).rejects.toThrow("active run");

      expect(request).not.toHaveBeenCalled();
      expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-active-child")).toBe(true);
    } finally {
      parent.unregister();
      harness.client.close();
    }
  });

  it.each([
    { sessionKey: undefined, knownBeforeResume: true },
    { sessionKey: "agent:main:dashboard:incognito-child", knownBeforeResume: true },
    { sessionKey: undefined, knownBeforeResume: false },
    { sessionKey: "agent:main:dashboard:incognito-child", knownBeforeResume: false },
  ])(
    "preserves a stored child binding when direct input is refused (session: $sessionKey, preflight: $knownBeforeResume)",
    async ({ sessionKey, knownBeforeResume }) => {
      const sessionFile = path.join(tempDir, "stored-child.jsonl");
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
      const threadId = "thread-parent-owned";
      const release = vi.fn(async () => undefined);
      if (knownBeforeResume) {
        await retainCodexAppServerLiveThread(harness.client, threadId, release);
      }
      await writeTestConversationBinding(sessionFile, { threadId, cwd: tempDir });
      const before = await readTestConversationBinding(sessionFile);
      const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
        if (method === "thread/read") {
          return {
            thread: conversationThreadStartResult(threadId, knownBeforeResume ? false : null)
              .thread,
          } as never;
        }
        if (method === "thread/resume") {
          return conversationThreadStartResult(threadId, false) as never;
        }
        if (method === "thread/unsubscribe") {
          return {} as never;
        }
        throw new Error(`unexpected Codex method ${method}`);
      });
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
      const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);

      try {
        await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toMatchObject({
          handled: true,
          reply: { text: expect.stringContaining("controlled by its parent") },
        });
        await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(before);
        expect(request.mock.calls.map(([method]) => method)).toEqual(
          knownBeforeResume
            ? ["thread/read"]
            : ["thread/read", "thread/resume", "thread/unsubscribe"],
        );
        expect(release).not.toHaveBeenCalled();
        const ownership = await consumeCodexAppServerLiveThread(harness.client, threadId);
        if (knownBeforeResume) {
          expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
        } else {
          expect(ownership).toBeUndefined();
        }
      } finally {
        harness.client.close();
      }
    },
  );

  it("keeps a retained native child owned when its pre-resume unsubscribe fails", async () => {
    const sessionFile = path.join(tempDir, "failed-child-session.jsonl");
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: conversationThreadStartResult("thread-failed-child").thread };
      }
      if (method === "thread/unsubscribe") {
        throw new Error("native child unsubscribe failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-failed-child",
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
    await retainCodexAppServerLiveThread(client, "thread-failed-child");
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    await expect(
      startCodexConversationThread({
        sessionFile,
        threadId: "thread-failed-child",
        workspaceDir: tempDir,
      }),
    ).rejects.toThrow("native child unsubscribe failed");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/unsubscribe",
    ]);
    await expect(consumeCodexAppServerLiveThread(client, "thread-failed-child")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it.each([
    { path: "binding" as const, rejectOldRelease: false },
    { path: "binding" as const, rejectOldRelease: true },
    { path: "bound turn" as const, rejectOldRelease: false },
    { path: "bound turn" as const, rejectOldRelease: true },
  ])(
    "transfers exact physical ownership during $path migration (old release fails: $rejectOldRelease)",
    async ({ path: migrationPath, rejectOldRelease }) => {
      const sessionFile = path.join(tempDir, "same-thread-client-migration.jsonl");
      const { previousClient, replacementClient, operations, ownerDuringRelease, readOwner } =
        await createSameThreadClientMigrationFixture(sessionFile, {
          rejectOldRelease,
          owner: migrationPath === "binding" ? "session" : "conversation",
        });

      if (migrationPath === "binding") {
        const binding = startCodexConversationThread({
          sessionFile,
          threadId: "thread-migrated",
          workspaceDir: tempDir,
        });
        if (rejectOldRelease) {
          await expect(binding).rejects.toThrow("previous physical client unsubscribe failed");
        } else {
          await expect(binding).resolves.toMatchObject({
            kind: "codex-app-server-session",
            source: { threadId: "thread-migrated" },
          });
        }
      } else {
        const { event, ctx } = boundConversationClaim(sessionFile);
        const result = await handleCodexConversationInboundClaim(event, ctx, { timeoutMs: 500 });
        expect(result?.reply?.text).toContain(
          rejectOldRelease ? "previous physical client unsubscribe failed" : "Migrated reply",
        );
      }

      const expectedOperations = ["replacement:thread/resume", "previous:thread/unsubscribe"];
      if (rejectOldRelease) {
        expectedOperations.push("replacement:thread/unsubscribe");
      } else if (migrationPath === "bound turn") {
        expectedOperations.push("replacement:turn/start");
      }
      expect(operations).toEqual(expectedOperations);
      expect(ownerDuringRelease).toEqual(["client-before-migration"]);
      await expect(readOwner()).resolves.toMatchObject({
        threadId: "thread-migrated",
        clientId: rejectOldRelease ? "client-before-migration" : "client-after-migration",
      });
      const survivingClient = rejectOldRelease ? previousClient : replacementClient;
      const obsoleteClient = rejectOldRelease ? replacementClient : previousClient;
      await expect(
        consumeCodexAppServerLiveThread(survivingClient, "thread-migrated"),
      ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
      await expect(
        consumeCodexAppServerLiveThread(obsoleteClient, "thread-migrated"),
      ).resolves.toBeUndefined();
    },
  );

  it("starts a new bind thread when no model override is provided", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.5",
        };
      }),
    });

    await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params).not.toHaveProperty("model");
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      model: "gpt-5.5",
    });
  });

  it("preserves Codex auth and omits the public OpenAI provider for native bind threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        work: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: tempDir,
      authProfileId: "work",
      modelProvider: "openai",
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
          modelProvider: "openai",
        };
      }),
    });

    await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("work");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[0]?.params.personality).toBe("none");
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.authProfileId).toBe("work");
    expect(savedBinding?.modelProvider).toBeUndefined();
  });

  it("stores and uses the owning agent dir for bound app-server sessions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
        model: "gpt-5.4-mini",
      })),
    });

    const data = await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      agentDir,
      model: "gpt-5.4-mini",
    });

    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(data.agentDir).toBe(agentDir);
  });

  it("rejects direct conversation start over a private supervised binding", async () => {
    const sessionFile = path.join(tempDir, "supervised-session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      startCodexConversationThread({
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4",
      }),
    ).rejects.toThrow("Refusing to replace supervised Codex thread");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-supervised",
      connectionScope: "supervision",
    });
  });

  it("rejects binding when configured exec auto mode may need unrouted human approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("rejects binding when the binding agent exec auto mode may need unrouted approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const request = vi.fn();
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "full",
            },
          },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: {
                  exec: {
                    mode: "auto",
                  },
                },
              },
            ],
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        agentId: "bot-a",
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects binding when configured exec ask mode needs unrouted user approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "ask",
            },
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("applies host exec approval floors to configless native bind threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({
      version: 1,
      defaults: {
        security: "deny",
        ask: "off",
      },
      agents: {},
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow("tools.exec.mode=deny");
    expect(execApprovalsRuntimeMocks.loadExecApprovals).toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("clears the Codex app-server binding when a pending bind is denied", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("retires an already-evicted conversation without disturbing its live client siblings", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-evicted" };
    const client = {
      request: vi.fn(async () => ({})),
      addCloseHandler: vi.fn(),
      addNotificationHandler: vi.fn(),
      addRequestHandler: vi.fn(),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
    const releaseEvicted = vi.fn(async (_threadId: string) => undefined);
    await retainCodexAppServerLiveThread(client, "thread-evicted", releaseEvicted);
    for (let index = 0; index < 64; index += 1) {
      await retainCodexAppServerLiveThread(
        client,
        `thread-sibling-${index}`,
        async () => undefined,
      );
    }
    expect(releaseEvicted).toHaveBeenCalledExactlyOnceWith("thread-evicted");
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
      client,
      release: vi.fn(),
    });
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-evicted",
        clientId: "client-with-siblings",
        cwd: tempDir,
        conversationStartId: "start-evicted",
      },
    });

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 2,
          bindingId: identity.bindingId,
          workspaceDir: tempDir,
          start: { id: "start-evicted" },
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:evicted",
        },
      },
    });

    expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
    await expect(consumeCodexAppServerLiveThread(client, "thread-sibling-0")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it("unsubscribes an untracked incognito conversation when its binding is denied", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-incognito" };
    const request = vi.fn(async () => ({}));
    const release = vi.fn();
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
      client: { request },
      release,
    });
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-incognito",
        clientId: "client-incognito",
        cwd: tempDir,
        conversationStartId: "start-incognito",
      },
    });

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 2,
          bindingId: identity.bindingId,
          workspaceDir: tempDir,
          source: {
            agentId: "main",
            sessionId: "session-incognito",
            threadId: "thread-source",
            sessionKey: "agent:main:dashboard:incognito-native-bind",
          },
          start: { id: "start-incognito" },
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:incognito",
        },
      },
    });

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-incognito" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
  });

  it("keeps a denied conversation binding when native unsubscribe fails", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-failed-denial" };
    const request = vi.fn(async () => {
      throw new Error("native unsubscribe failed");
    });
    const closeAndWait = vi.fn(async () => true);
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
      client: { request, closeAndWait },
      release: vi.fn(),
    });
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-failed-denial",
        clientId: "client-failed-denial",
        cwd: tempDir,
        conversationStartId: "start-failed-denial",
      },
    });

    await expect(
      handleCodexConversationBindingResolved({
        status: "denied",
        decision: "deny",
        request: {
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: identity.bindingId,
            workspaceDir: tempDir,
            source: {
              agentId: "main",
              sessionId: "session-incognito",
              threadId: "thread-source",
              sessionKey: "agent:main:dashboard:incognito-native-bind",
            },
            start: { id: "start-failed-denial" },
          },
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "channel:incognito",
          },
        },
      }),
    ).rejects.toThrow("subscription could not be released");

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-failed-denial" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: "thread-failed-denial",
    });
    expect(closeAndWait).toHaveBeenCalledOnce();
  });

  it("preserves the live conversation generation when a replacement bind is denied", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-data-1" };
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-old",
        cwd: tempDir,
        conversationStartId: "start-old",
      },
    });

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 2,
          bindingId: "binding-data-1",
          workspaceDir: tempDir,
          start: { id: "start-new", threadId: "thread-new" },
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: "thread-old",
      conversationStartId: "start-old",
    });
  });

  it("rejects attaching a conversation to another session's owned thread", async () => {
    const otherIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-other",
    };
    await testCodexAppServerBindingStore.mutate(otherIdentity, {
      kind: "set",
      binding: { threadId: "thread-owned", cwd: tempDir },
    });
    const request = vi.fn(async () => conversationThreadStartResult("thread-owned"));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      startCodexConversationThread({
        sessionFile: path.join(tempDir, "session.jsonl"),
        workspaceDir: tempDir,
        threadId: "thread-owned",
      }),
    ).rejects.toThrow("owned by another OpenClaw session");
    expect(request).not.toHaveBeenCalled();
    expect(testCodexAppServerBindingStore.read(otherIdentity)).toMatchObject({
      threadId: "thread-owned",
    });
  });

  it("consumes inbound bound messages when command authorization is absent", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
        senderIsOwner: false,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile: path.join(tempDir, "session.jsonl"),
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(result).toEqual({ handled: true });
  });

  it("blocks inbound bound turns without current owner or admin authority", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        senderIsOwner: false,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile: path.join(tempDir, "session.jsonl"),
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: { text: "Only an owner or operator.admin can control Codex native execution." },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("routes a programmatically bound Control UI session through node resume", async () => {
    const resumeCodexCliSessionOnNode = vi.fn(async () => ({
      ok: true as const,
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      text: "done",
    }));

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "webchat",
        isGroup: false,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "webchat",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "webchat",
          accountId: "default",
          conversationId: "node-session",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "mb-m5" } } },
        resumeCodexCliSessionOnNode,
        timeoutMs: 1234,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(resumeCodexCliSessionOnNode).toHaveBeenCalledWith({
      nodeId: "mb-m5",
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      prompt: "continue the task",
      cwd: "/repo",
      timeoutMs: 1234,
    });
  });

  it("blocks bound Codex app-server turns when the current OpenClaw session is sandboxed", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex app-server turns when exec host=node is active", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw exec host=node is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex app-server turns when the binding agent uses node exec without a session key", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        config: {
          tools: { exec: { host: "gateway" } },
          agents: {
            entries: {
              "bot-a": { tools: { exec: { host: "node", node: "worker-1" } } },
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("OpenClaw exec host=node is active");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("does not infer an unscoped session owner from an explicit multi-agent roster", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "alpha",
          },
        },
      },
      {
        config: {
          tools: { exec: { host: "gateway" } },
          agents: {
            entries: {
              alpha: { tools: { exec: { host: "node", node: "worker-1" } } },
              beta: {},
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("OpenClaw exec host=node is active");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound agent node exec block ahead of current-session exec host overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:session-1",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        execHost: "gateway",
      },
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "discord",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        config: {
          session: {
            store: path.join(tempDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          tools: { exec: { host: "gateway" } },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: { exec: { host: "node", node: "worker-1" } },
              },
            ],
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("OpenClaw exec host=node is active");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("rejects bound Codex app-server turns when the binding agent exec auto mode needs approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
    const request = vi.fn(async () => {
      throw new Error("unexpected native turn");
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          tools: {
            exec: {
              mode: "full",
            },
          },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: {
                  exec: {
                    mode: "auto",
                  },
                },
              },
            ],
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks bound Codex CLI node turns when the current OpenClaw session is sandboxed", async () => {
    const resumeCodexCliSessionOnNode = vi.fn();

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        resumeCodexCliSessionOnNode,
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex CLI node conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(resumeCodexCliSessionOnNode).not.toHaveBeenCalled();
  });

  it("re-reads source-owned permission roots while recovering a missing bound thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const storePath = path.join(tempDir, "recovery.sqlite");
    const source = {
      agentId: "main",
      sessionId: "recovery-source",
      sessionKey: "agent:main:recovery-source",
      threadId: "thread-source",
    };
    const recoveredRoot = path.join(tempDir, "recovered-root");
    await upsertSessionEntry({
      ...source,
      storePath,
      entry: {
        sessionId: source.sessionId,
        updatedAt: Date.now(),
        permissionMode: "full",
        sessionRoot: tempDir,
      },
    });
    codexRequirementsTomlMock.mockReturnValue(
      [
        'allowed_sandbox_modes = ["workspace-write"]',
        'allowed_approval_policies = ["on-request"]',
        'allowed_approvals_reviewers = ["auto_review"]',
      ].join("\n"),
    );
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        work: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-old",
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: "fast",
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          await upsertSessionEntry({
            ...source,
            storePath,
            entry: {
              sessionId: source.sessionId,
              updatedAt: Date.now(),
              permissionMode: "workspace",
              sessionRoot: recoveredRoot,
            },
          });
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [
                      {
                        id: "assistant-1",
                        type: "agentMessage",
                        text: "Recovered",
                      },
                    ],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: legacyCodexConversationBindingId(sessionFile),
            workspaceDir: tempDir,
            source: {
              agentId: source.agentId,
              sessionId: source.sessionId,
              threadId: source.threadId,
            },
          },
        },
      },
      { config: { session: { store: storePath } }, timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered" } });
    expect(requests.map((request) => request.method)).toEqual([
      "turn/start",
      "thread/start",
      "turn/start",
    ]);
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("work");
    expect(requests[0]?.params).toMatchObject({
      cwd: tempDir,
      runtimeWorkspaceRoots: [tempDir],
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(requests[1]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[1]?.params).toMatchObject({
      cwd: recoveredRoot,
      runtimeWorkspaceRoots: [recoveredRoot],
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
    expect(requests[1]?.params.serviceTier).toBe("priority");
    expect(requests[1]?.params).not.toHaveProperty("modelProvider");
    expect(requests[2]?.params.threadId).toBe("thread-new");
    expect(requests[2]?.params).toMatchObject({
      cwd: recoveredRoot,
      runtimeWorkspaceRoots: [recoveredRoot],
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [recoveredRoot] },
    });
    expect(requests[2]?.params.serviceTier).toBe("priority");
    const savedBinding = await readTestConversationBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
    expect(savedBinding?.authProfileId).toBe("work");
    expect(savedBinding).not.toHaveProperty("approvalPolicy");
    expect(savedBinding).not.toHaveProperty("sandbox");
    expect(savedBinding?.serviceTier).toBe("priority");
    expect(savedBinding).not.toHaveProperty("modelProvider");
  });

  it("applies a new lazy bind generation before running its first turn", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-data-1" };
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-old",
        cwd: "/old-repo",
        conversationStartId: "start-old",
      },
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          requests.push({ method, params: requestParams });
          return conversationThreadStartResult("thread-target");
        }
        if (method === "thread/read") {
          return { thread: conversationThreadStartResult("thread-target").thread };
        }
        requests.push({ method, params: requestParams });
        if (method === "turn/start") {
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-target",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "rebound" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "binding-data-1",
            workspaceDir: "/new-repo",
            start: { id: "start-new", threadId: "thread-target" },
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "rebound" } });
    expect(requests.map((request) => request.method)).toEqual(["thread/resume", "turn/start"]);
    expect(requests[0]?.params.threadId).toBe("thread-target");
    expect(requests[1]?.params.cwd).toBe("/new-repo");
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: "thread-target",
      cwd: "/new-repo",
      conversationStartId: "start-new",
    });
  });

  it("moves session history while clamping rootless inherited cwd to the agent workspace", async () => {
    const source = {
      agentId: "main",
      sessionId: "source-session",
      sessionKey: "agent:main:source-session",
      threadId: "thread-source",
    };
    const storePath = path.join(tempDir, "source.sqlite");
    await upsertSessionEntry({
      ...source,
      storePath,
      entry: {
        sessionId: source.sessionId,
        updatedAt: Date.now(),
        permissionMode: "workspace",
      },
    });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:destination-session",
      storePath,
      entry: {
        sessionId: "destination-session",
        updatedAt: Date.now(),
      },
    });
    codexRequirementsTomlMock.mockReturnValue(
      [
        'allowed_sandbox_modes = ["workspace-write"]',
        'allowed_approval_policies = ["on-request"]',
        'allowed_approvals_reviewers = ["auto_review"]',
      ].join("\n"),
    );
    await appendSessionTranscriptMessageByIdentity({
      ...source,
      storePath,
      message: { role: "user", content: "Earlier question", timestamp: 1 },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...source,
      storePath,
      message: { role: "assistant", content: "Earlier answer", timestamp: 2 },
    });
    const sourceIdentity = {
      kind: "session" as const,
      agentId: source.agentId,
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
    };
    await testCodexAppServerBindingStore.mutate(sourceIdentity, {
      kind: "set",
      binding: {
        threadId: source.threadId,
        clientId: "source-client",
        cwd: path.join(tempDir, "..", "outside-rootless-session"),
        model: "gpt-5.5",
        modelProvider: "openai",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        dynamicToolsFingerprint: "harness-only-tools",
      },
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const releaseSource = vi.fn(async () => undefined);
    const client = {
      getInstanceId: () => "source-client",
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return conversationThreadStartResult("thread-bound");
        }
        if (method === "thread/inject_items") {
          return {};
        }
        if (method === "turn/start") {
          queueMicrotask(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-bound",
                  turn: {
                    id: "turn-bound",
                    status: "completed",
                    items: [{ type: "agentMessage", id: "answer", text: "Bound reply" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-bound" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
    await retainCodexAppServerLiveThread(client, source.threadId, releaseSource);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
      client,
      release: vi.fn(),
    });
    const { event, ctx } = boundConversationClaim(
      path.join(tempDir, "session.jsonl"),
      "agent:main:destination-session",
    );
    ctx.pluginBinding.data = {
      kind: "codex-app-server-session" as const,
      version: 2 as const,
      bindingId: "binding-source-transfer",
      workspaceDir: tempDir,
      source,
    };

    await expect(
      handleCodexConversationInboundClaim(event, ctx, {
        config: { session: { store: storePath } },
        timeoutMs: 500,
      }),
    ).resolves.toEqual({ handled: true, reply: { text: "Bound reply" } });

    expect(requests.map(({ method }) => method)).toEqual([
      "thread/start",
      "thread/inject_items",
      "turn/start",
    ]);
    expect(requests[0]?.params).toMatchObject({
      cwd: "/agent/workspace",
      runtimeWorkspaceRoots: ["/agent/workspace"],
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      developerInstructions: expect.stringContaining("bound to an OpenClaw conversation"),
      config: { apps: { _default: { enabled: false } }, "features.apps": false },
    });
    expect(requests[2]?.params).toMatchObject({
      cwd: "/agent/workspace",
      runtimeWorkspaceRoots: ["/agent/workspace"],
      sandboxPolicy: { type: "workspaceWrite" },
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(requests[0]?.params).not.toHaveProperty("dynamicTools");
    expect(requests[1]?.params.items).toMatchObject([
      { role: "user", content: [{ text: "Earlier question" }] },
      { role: "assistant", content: [{ text: "Earlier answer" }] },
    ]);
    expect(releaseSource).toHaveBeenCalledExactlyOnceWith("thread-source");
    expect(testCodexAppServerBindingStore.read(sourceIdentity)).toBeUndefined();
    await expect(consumeCodexAppServerLiveThread(client, "thread-bound")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it.each([
    { label: "a registered source run after its client was retired", exposeClient: false },
    { label: "a live client whose source subscription is claimed", exposeClient: true },
  ])("does not transfer $label into a bound conversation", async ({ exposeClient }) => {
    const source = {
      agentId: "main",
      sessionId: "active-source-session",
      sessionKey: "agent:main:active-source-session",
      threadId: "thread-active-source",
    };
    const sourceIdentity = {
      kind: "session" as const,
      agentId: source.agentId,
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
    };
    const storePath = path.join(tempDir, "active-source.sqlite");
    await upsertSessionEntry({
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      storePath,
      entry: { sessionId: source.sessionId, updatedAt: Date.now() },
    });
    await testCodexAppServerBindingStore.mutate(sourceIdentity, {
      kind: "set",
      binding: { threadId: source.threadId, clientId: "active-client", cwd: tempDir },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return conversationThreadStartResult("thread-active-target");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "active-client",
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    if (exposeClient) {
      await retainCodexAppServerLiveThread(client, source.threadId, async () => undefined);
      await consumeCodexAppServerLiveThread(client, source.threadId);
      sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
        client,
        release: vi.fn(),
      });
    }
    const activeRun = {
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    if (!exposeClient) {
      setActiveEmbeddedRun(source.sessionId, activeRun, source.sessionKey);
    }
    const { event, ctx } = boundConversationClaim(path.join(tempDir, "active-source.jsonl"));
    ctx.pluginBinding.data = {
      kind: "codex-app-server-session" as const,
      version: 2 as const,
      bindingId: "binding-active-source",
      workspaceDir: tempDir,
      source,
      start: { id: "start-active-source" },
    };

    try {
      const result = await handleCodexConversationInboundClaim(event, ctx, {
        config: { session: { store: storePath } },
        timeoutMs: 500,
      });

      expect(result?.reply?.text).toContain("active run");
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
      expect(testCodexAppServerBindingStore.read(sourceIdentity)).toMatchObject({
        threadId: source.threadId,
      });
      expect(
        testCodexAppServerBindingStore.read({
          kind: "conversation",
          bindingId: "binding-active-source",
        }),
      ).not.toHaveProperty("conversationSourceTransferComplete", true);
    } finally {
      if (!exposeClient) {
        clearActiveEmbeddedRun(source.sessionId, activeRun, source.sessionKey);
      }
    }
  });

  it("recreates a missing bound thread with the stored binding agent runtime policy", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-old",
      cwd: tempDir,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        timeoutMs: 500,
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: {
                  exec: {
                    mode: "full",
                  },
                },
              },
            ],
          },
        } as never,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered" } });
    expect(requests.map((request) => request.method)).toEqual([
      "turn/start",
      "thread/start",
      "turn/start",
    ]);
    expect(requests[0]?.params.approvalPolicy).toBe("never");
    expect(requests[0]?.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(requests[1]?.params.approvalPolicy).toBe("never");
    expect(requests[1]?.params.sandbox).toBe("danger-full-access");
    expect(requests[2]?.params.approvalPolicy).toBe("never");
    expect(requests[2]?.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  it("does not silently decline auto-mode approvals during missing thread recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-old",
      cwd: tempDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 500,
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("creates a fresh thread when recovery finds the binding already cleared", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.5-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered fresh" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "redacted-group",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered fresh" } });
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[1]?.params.threadId).toBe("thread-new");
    expect(requests[1]?.params.personality).toBe("none");
    const savedBinding = await readTestConversationBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
  });

  it("passes sandbox state when resolving bound turn policy", async () => {
    codexRequirementsTomlMock.mockReturnValue(
      [
        'allowed_sandbox_modes = ["read-only", "workspace-write"]',
        'allowed_approval_policies = ["never", "on-request"]',
        'allowed_approvals_reviewers = ["user"]',
      ].join("\n"),
    );
    resolveSandboxContextMock.mockResolvedValue({ enabled: true });
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        bodyForAgent: "continue",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "telegram",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "on-miss",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(result?.reply?.text).not.toContain(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
    expect(resolveSandboxContextMock).toHaveBeenCalledWith({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "on-miss",
          },
        },
      },
      sessionKey: "agent:main:session-1",
      workspaceDir: "/agent/workspace",
    });
    expect(turnStartParams).toEqual([]);
  });

  it("returns a clean failure reply when app-server turn start rejects", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionKey = "agent:main:dashboard:incognito-bound-failure";
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "openai:work",
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const requests: string[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        requests.push(method);
        if (method === "turn/start") {
          throw new Error(
            "unexpected status 401 Unauthorized: Missing bearer <@U123> [trusted](https://evil) @here",
          );
        }
        if (method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        {
          content: "hi",
          bodyForAgent: "hi",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
          sessionKey,
        },
        {
          channelId: "telegram",
          sessionKey,
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
              agentDir,
            },
          },
        },
        { timeoutMs: 50 },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(result).toEqual({
        handled: true,
        reply: {
          text: "Codex app-server turn failed: unexpected status 401 Unauthorized: Missing bearer &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        },
      });
      const replyText = result?.reply?.text ?? "";
      expect(replyText).not.toContain("<@U123>");
      expect(replyText).not.toContain("[trusted](https://evil)");
      expect(replyText).not.toContain("@here");
      expect(unhandledRejections).toStrictEqual([]);
      expect(requests).toEqual(["turn/start", "thread/unsubscribe"]);
      await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("gracefully retires an incognito client when failed turn cleanup cannot unsubscribe", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionKey = "agent:main:dashboard:incognito-unsubscribe-failure";
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") {
        throw new Error("original bound turn failure");
      }
      if (method === "thread/unsubscribe") {
        throw new Error("thread unsubscribe failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const closeAndWait = vi.fn(async () => true);
    const client = {
      request,
      closeAndWait,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed.mockReturnValue({
      found: true,
      closed: false,
    });
    sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReturnValue({
      activeLeases: 2,
      closed: false,
    });
    const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);

    await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
      handled: true,
      reply: { text: "Codex app-server turn failed: original bound turn failure" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledWith(
      client,
    );
    expect(closeAndWait).not.toHaveBeenCalled();
    await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("preserves the original incognito failure if client retirement also rejects", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionKey = "agent:main:dashboard:incognito-retirement-failure";
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    const closeAndWait = vi.fn(async () => {
      throw new Error("client retirement failed");
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      closeAndWait,
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          throw new Error("original bound turn failure");
        }
        if (method === "thread/unsubscribe") {
          throw new Error("thread unsubscribe failed");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);

    await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
      handled: true,
      reply: { text: "Codex app-server turn failed: original bound turn failure" },
    });

    expect(closeAndWait).toHaveBeenCalledOnce();
    await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
  });

  it.each([
    { label: "structured failure", code: -32_603, cleaned: true },
    { label: "overload rejection", code: -32_001, cleaned: false },
  ])(
    "preserves incognito reconnect $label without redundant cleanup",
    async ({ code, cleaned }) => {
      const sessionFile = path.join(tempDir, "incognito-reconnect.jsonl");
      await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
      const binding = await readTestConversationBinding(sessionFile);
      const rejection = new CodexAppServerRpcError(
        {
          code,
          message: cleaned ? "resume response assembly failed" : "thread not found: thread-1",
        },
        "thread/resume",
      );
      let unsubscribed = false;
      const request = vi.fn(async (method: string) => {
        if (method === "thread/read") {
          return { thread: conversationThreadStartResult("thread-1").thread };
        }
        if (method === "thread/resume") {
          throw rejection;
        }
        if (method === "thread/unsubscribe" && cleaned && !unsubscribed) {
          unsubscribed = true;
          return { status: "unsubscribed" };
        }
        throw new Error(`unexpected cleanup or fallback: ${method}`);
      });
      const closeAndWait = vi.fn(async () => true);
      const client = { request, closeAndWait, getInstanceId: () => "reconnected-client" };
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
      const { event, ctx } = boundConversationClaim(
        sessionFile,
        "agent:main:dashboard:incognito-reconnect",
      );

      await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
        handled: true,
        reply: {
          text: `Codex app-server turn failed: ${rejection.message}`,
        },
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual(
        cleaned
          ? ["thread/read", "thread/resume", "thread/unsubscribe"]
          : ["thread/read", "thread/resume"],
      );
      expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
      expect(closeAndWait).not.toHaveBeenCalled();
      await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(
        cleaned ? undefined : binding,
      );
    },
  );

  it.each([
    { label: "ordinary", sessionKey: undefined },
    { label: "incognito", sessionKey: "agent:main:dashboard:incognito-resume-failure" },
  ])(
    "retires an indeterminate $label resume once without closing sibling leases",
    async ({ sessionKey }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      await writeTestConversationBinding(sessionFile, {
        threadId: "thread-1",
        cwd: tempDir,
      });
      const request = vi.fn(async (method: string) => {
        if (method === "thread/read") {
          return { thread: conversationThreadStartResult("thread-1").thread };
        }
        if (method === "thread/resume") {
          throw new Error("thread not found: thread-1");
        }
        if (method === "thread/unsubscribe") {
          throw new Error("detached client must not receive another cleanup request");
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const closeAndWait = vi.fn(async () => true);
      const client = {
        request,
        closeAndWait,
        getInstanceId: () => "replacement-client",
      };
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
      sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed
        .mockReturnValueOnce({ found: true, closed: false })
        .mockReturnValue({ found: false, closed: false });
      sharedClientMocks.retireSharedCodexAppServerClientIfCurrent
        .mockReturnValueOnce({ activeLeases: 2, closed: false })
        .mockReturnValue(undefined);
      const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);

      await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
        handled: true,
        reply: { text: "Codex app-server turn failed: thread not found: thread-1" },
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/resume",
      ]);
      expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledOnce();
      expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledWith(
        client,
      );
      expect(closeAndWait).not.toHaveBeenCalled();
      if (sessionKey) {
        await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
      } else {
        await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-1",
          clientId: "test-client",
        });
      }
    },
  );

  it("retains a pre-start final after a saturated commentary stream", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        for (let index = 0; index < 100; index += 1) {
          notificationHandler?.({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                type: "agentMessage",
                id: `commentary-${index}`,
                text: `progress ${index}`,
                phase: "commentary",
              },
            },
          });
        }
        notificationHandler?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "answer", text: "authoritative answer" },
          },
        });
        notificationHandler?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null, items: [] },
          },
        });
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const { event, ctx } = boundConversationClaim(sessionFile);

    await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
      handled: true,
      reply: { text: "authoritative answer" },
    });
  });

  it("reports an interrupted bound turn as cancellation instead of a partial reply", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        queueMicrotask(() => {
          notificationHandler?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "item-1",
              delta: "unfinished answer",
            },
          });
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
            },
          });
        });
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const { event, ctx } = boundConversationClaim(sessionFile);

    await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
      handled: true,
      reply: { text: "Codex app-server turn failed: codex app-server turn interrupted" },
    });
  });

  it("does not interrupt a provider failure that matches the local timeout message", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method !== "turn/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      queueMicrotask(() => {
        notificationHandler?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "codex app-server bound turn timed out" },
              items: [],
            },
          },
        });
      });
      return { turn: { id: "turn-1" } };
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const { event, ctx } = boundConversationClaim(sessionFile);

    await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toEqual({
      handled: true,
      reply: { text: "Codex app-server turn failed: codex app-server bound turn timed out" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["turn/start"]);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
    });
  });

  it.each([
    { label: "ordinary", sessionKey: undefined, interruptFails: false },
    {
      label: "incognito",
      sessionKey: "agent:main:dashboard:incognito-start-timeout",
      interruptFails: false,
    },
    { label: "ordinary with a failed interrupt", sessionKey: undefined, interruptFails: true },
    {
      label: "incognito with a failed interrupt",
      sessionKey: "agent:main:dashboard:incognito-start-interrupt-failure",
      interruptFails: true,
    },
  ])(
    "interrupts an indeterminate $label native turn before cleanup",
    async ({ sessionKey, interruptFails }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const harness = createClientHarness();
      await writeTestConversationBinding(sessionFile, {
        threadId: "thread-1",
        clientId: harness.client.getInstanceId(),
        cwd: tempDir,
      });
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
      if (interruptFails) {
        sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReturnValueOnce({
          activeLeases: 2,
          closed: false,
        });
      }
      const waitForRequest = async (method: string) =>
        await vi.waitFor(
          () => {
            const request = harness.writes
              .map((write) => JSON.parse(write) as { id: number; method: string; params: unknown })
              .find((message) => message.method === method);
            if (!request) {
              throw new Error(`Codex conversation harness did not write ${method}`);
            }
            return request;
          },
          { interval: 1, timeout: 5_000 },
        );
      const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
      const result = handleCodexConversationInboundClaim(event, ctx, {
        pluginConfig: { appServer: { requestTimeoutMs: 100 } },
      });
      const turnStart = await waitForRequest("turn/start");
      const interrupt = await waitForRequest("turn/interrupt");
      expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "" });
      harness.send({ id: turnStart.id, result: { turn: { id: "turn-1" } } });
      harness.send(
        interruptFails
          ? { id: interrupt.id, error: { code: -32_000, message: "startup interrupt failed" } }
          : { id: interrupt.id, result: {} },
      );
      if (sessionKey && !interruptFails) {
        const unsubscribe = await waitForRequest("thread/unsubscribe");
        harness.send({ id: unsubscribe.id, result: {} });
      }

      await expect(result).resolves.toEqual({
        handled: true,
        reply: { text: "Codex app-server turn failed: turn/start timed out" },
      });
      expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
        "turn/start",
        "turn/interrupt",
        ...(sessionKey && !interruptFails ? ["thread/unsubscribe"] : []),
      ]);
      expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledTimes(
        interruptFails ? 1 : 0,
      );
      expect(
        readCodexConversationActiveTurn(testConversationIdentity(sessionFile)),
      ).toBeUndefined();
      if (sessionKey) {
        await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
      }
      harness.client.close();
    },
  );

  it.each([
    { label: "ordinary", sessionKey: undefined },
    { label: "incognito", sessionKey: "agent:main:dashboard:incognito-turn-timeout" },
  ])(
    "interrupts a timed-out $label turn before removing active tracking and handlers",
    async ({ sessionKey }) => {
      vi.useFakeTimers();
      try {
        const sessionFile = path.join(tempDir, "session.jsonl");
        await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
        const identity = testConversationIdentity(sessionFile);
        const cleanupEvents: string[] = [];
        const notificationHandlers = new Set<(notification: unknown) => void>();
        const request = vi.fn(async (method: string) => {
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "thread/unsubscribe") {
            cleanupEvents.push("unsubscribe");
            return {};
          }
          if (method !== "turn/interrupt") {
            throw new Error(`unexpected method: ${method}`);
          }
          cleanupEvents.push("interrupt");
          expect(readCodexConversationActiveTurn(identity)).toMatchObject({
            threadId: "thread-1",
            turnId: "turn-1",
          });
          queueMicrotask(() => {
            cleanupEvents.push("turn completed");
            expect(readCodexConversationActiveTurn(identity)).toMatchObject({
              threadId: "thread-1",
              turnId: "turn-1",
            });
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
                },
              });
            }
          });
          return {};
        });
        const client = {
          request,
          addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
            notificationHandlers.add(handler);
            return () => {
              notificationHandlers.delete(handler);
              cleanupEvents.push("notification cleanup");
            };
          }),
          addRequestHandler: vi.fn(() => () => cleanupEvents.push("request cleanup")),
          addCloseHandler: vi.fn(() => () => undefined),
        };
        sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
        const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
        const result = handleCodexConversationInboundClaim(event, ctx, { timeoutMs: 100 });

        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledWith("turn/start", expect.any(Object), expect.any(Object));
        await vi.advanceTimersByTimeAsync(100);

        await expect(result).resolves.toEqual({
          handled: true,
          reply: { text: "Codex app-server turn failed: codex app-server bound turn timed out" },
        });
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          { threadId: "thread-1", turnId: "turn-1" },
          { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
        );
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "turn/start",
          "turn/interrupt",
          ...(sessionKey ? ["thread/unsubscribe"] : []),
        ]);
        expect(cleanupEvents).toEqual([
          "interrupt",
          "turn completed",
          ...(sessionKey ? ["unsubscribe"] : []),
        ]);
        expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
        expect(readCodexConversationActiveTurn(identity)).toBeUndefined();
        if (sessionKey) {
          await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
        } else {
          await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
            threadId: "thread-1",
          });
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { label: "a failed ordinary", sessionKey: undefined, acknowledged: false },
    { label: "an unconfirmed ordinary", sessionKey: undefined, acknowledged: true },
    {
      label: "a failed incognito",
      sessionKey: "agent:main:dashboard:incognito-interrupt-failure",
      acknowledged: false,
    },
  ])(
    "retires $label timeout interrupt once without closing sibling leases",
    async ({ sessionKey, acknowledged }) => {
      vi.useFakeTimers();
      try {
        const sessionFile = path.join(tempDir, "session.jsonl");
        await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
        const identity = testConversationIdentity(sessionFile);
        const closeAndWait = vi.fn(async () => true);
        const request = vi.fn(async (method: string) => {
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "turn/interrupt") {
            if (acknowledged) {
              return {};
            }
            throw new Error("turn interrupt could not be confirmed");
          }
          if (method === "thread/unsubscribe") {
            throw new Error("detached client must not receive another cleanup request");
          }
          throw new Error(`unexpected method: ${method}`);
        });
        const client = {
          request,
          closeAndWait,
          addNotificationHandler: vi.fn(() => () => undefined),
          addRequestHandler: vi.fn(() => () => undefined),
          addCloseHandler: vi.fn(() => () => undefined),
        };
        sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
        sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed
          .mockReturnValueOnce({ found: true, closed: false })
          .mockReturnValue({ found: false, closed: false });
        sharedClientMocks.retireSharedCodexAppServerClientIfCurrent
          .mockReturnValueOnce({ activeLeases: 2, closed: false })
          .mockReturnValue(undefined);
        const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
        const result = handleCodexConversationInboundClaim(event, ctx, { timeoutMs: 100 });

        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledWith("turn/start", expect.any(Object), expect.any(Object));
        await vi.advanceTimersByTimeAsync(100);
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          { threadId: "thread-1", turnId: "turn-1" },
          { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
        );
        if (acknowledged) {
          expect(readCodexConversationActiveTurn(identity)).toMatchObject({
            threadId: "thread-1",
            turnId: "turn-1",
          });
          expect(
            sharedClientMocks.retireSharedCodexAppServerClientIfCurrent,
          ).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(5_000);
        }

        await expect(result).resolves.toEqual({
          handled: true,
          reply: { text: "Codex app-server turn failed: codex app-server bound turn timed out" },
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "turn/start",
          "turn/interrupt",
        ]);
        expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledOnce();
        expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledWith(
          client,
        );
        expect(closeAndWait).not.toHaveBeenCalled();
        expect(readCodexConversationActiveTurn(identity)).toBeUndefined();
        if (sessionKey) {
          await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
        } else {
          await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
            threadId: "thread-1",
          });
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("falls back to content when the channel body for agent is blank", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "use the fallback prompt",
        bodyForAgent: "",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(turnStartParams[0]?.input).toEqual([
      { type: "text", text: "use the fallback prompt", text_elements: [] },
    ]);
    expect(turnStartParams[0]?.approvalPolicy).toBe("never");
    expect(turnStartParams[0]?.approvalsReviewer).toBe("user");
    expect(turnStartParams[0]?.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });

  it("keeps network-proxy bound app-server turns on their thread permissions profile", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      networkProxyProfileName: NETWORK_PROXY_PROFILE_NAME,
      networkProxyConfigFingerprint: NETWORK_PROXY_CONFIG_FINGERPRINT,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hello",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        pluginConfig: {
          appServer: {
            networkProxy: {
              enabled: true,
              domains: { "api.openai.com": "allow" },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
        timeoutMs: 50,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(turnStartParams[0]).not.toHaveProperty("permissions");
    expect(turnStartParams[0]).not.toHaveProperty("sandboxPolicy");
  });

  it("refreshes stale network-proxy bound app-server threads before the turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-old",
      cwd: tempDir,
      networkProxyProfileName: "openclaw-network-stale",
      networkProxyConfigFingerprint: "stale-proxy-config",
      conversationStartId: "start-1",
      conversationSourceTransferComplete: true,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "thread/start") {
          return conversationThreadStartResult("thread-new");
        }
        if (method === "turn/start") {
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-new",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hello",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        pluginConfig: {
          appServer: {
            serviceTier: "priority",
            networkProxy: {
              enabled: true,
              domains: { "api.openai.com": "allow" },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
        timeoutMs: 50,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
    expect(requests[0]?.params).not.toHaveProperty("sandbox");
    expect(requests[0]?.params.serviceTier).toBe("priority");
    expect(requests[1]?.params.threadId).toBe("thread-new");
    expect(requests[1]?.params).not.toHaveProperty("sandboxPolicy");
    const bindingAfterRefresh = await readTestConversationBinding(sessionFile);
    expect(bindingAfterRefresh?.threadId).toBe("thread-new");
    expect(bindingAfterRefresh?.networkProxyProfileName).toBe(NETWORK_PROXY_PROFILE_NAME);
    expect(bindingAfterRefresh?.networkProxyConfigFingerprint).toBe(
      NETWORK_PROXY_CONFIG_FINGERPRINT,
    );
    expect(bindingAfterRefresh?.conversationStartId).toBe("start-1");
    expect(bindingAfterRefresh?.conversationSourceTransferComplete).toBe(true);
  });

  it("restores the old owner and rolls back a network replacement when unsubscribe fails", async () => {
    const sessionFile = path.join(tempDir, "network-rotation-release-failure.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-old",
      clientId: "client-network-rotation",
      cwd: tempDir,
      networkProxyProfileName: "openclaw-network-stale",
      networkProxyConfigFingerprint: "stale-proxy-config",
      conversationStartId: "start-1",
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      getInstanceId: () => "client-network-rotation",
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return conversationThreadStartResult("thread-new");
        }
        if (method === "thread/unsubscribe" && params.threadId === "thread-old") {
          throw new Error("old thread unsubscribe failed");
        }
        if (method === "thread/unsubscribe" && params.threadId === "thread-new") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
    await expect(
      retainCodexAppServerLiveThread(client, "thread-old", async (threadId) => {
        await client.request("thread/unsubscribe", { threadId });
      }),
    ).resolves.toBe(true);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    const { event, ctx } = boundConversationClaim(sessionFile);

    const result = await handleCodexConversationInboundClaim(event, ctx, {
      pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
    });

    expect(result?.reply?.text).toContain("old thread unsubscribe failed");
    expect(requests).toEqual([
      { method: "thread/start", params: expect.any(Object) },
      { method: "thread/unsubscribe", params: { threadId: "thread-old" } },
      { method: "thread/unsubscribe", params: { threadId: "thread-new" } },
    ]);
    await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
      clientId: "client-network-rotation",
      threadId: "thread-old",
    });
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-old")).toBe(false);
    await expect(consumeCodexAppServerLiveThread(client, "thread-old")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(consumeCodexAppServerLiveThread(client, "thread-new")).resolves.toBeUndefined();
  });

  it("blocks Guardian-mode bound turns with stale no-approval policy on custom model providers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hello",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 50,
        pluginConfig: {
          appServer: {
            mode: "guardian",
          },
        },
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(turnStartParams).toEqual([]);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("infers custom model providers for legacy bound turns without stored modelProvider", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "lmstudio/local-model",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    await expect(
      handleCodexConversationInboundClaim(
        {
          content: "hello",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
            },
          },
        },
        {
          timeoutMs: 50,
          pluginConfig: {
            appServer: {
              mode: "guardian",
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
        ),
      },
    });

    expect(turnStartParams).toEqual([]);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
