// Codex tests cover conversation binding plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
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

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: async (...args: unknown[]) => {
    const client = (await sharedClientMocks.getSharedCodexAppServerClient(...args)) as {
      getInstanceId?: () => string;
    };
    client.getInstanceId ??= () => "test-client";
    return client;
  },
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withLeasedCodexAppServerClientStartSelectionRetry: async (params: {
    lease: { client?: unknown };
    run: (client: unknown) => Promise<unknown>;
  }) => await params.run(params.lease.client),
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

import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { legacyCodexConversationBindingId } from "./conversation-binding-data.js";
import { codexConversationBindingRuntime } from "./conversation-binding.js";

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
  return await testCodexAppServerBindingStore.read(testConversationIdentity(sessionFile));
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

function conversationThreadStartResult(threadId: string) {
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
      cliVersion: "0.125.0",
      source: "unknown",
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
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    agentRuntimeMocks.ensureAuthProfileStore.mockReset();
    agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
    agentRuntimeMocks.resolveAuthProfileOrder.mockReset();
    agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.resolveSessionAgentIds.mockClear();
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
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation(
      (provider: string, _lookup?: { config?: unknown }) => provider,
    );
    agentRuntimeMocks.resolveSessionAgentIds.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
  });

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
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
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

    const authOrderParams = mockCallArg(agentRuntimeMocks.resolveAuthProfileOrder) as {
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
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      authProfileId: "openai:default",
    });
  });

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

    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: "thread-old",
      conversationStartId: "start-old",
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

  it("keeps bound agent approval policy ahead of different-agent session overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const storePath = path.join(tempDir, "sessions.json");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:session-1",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        execSecurity: "full",
        execAsk: "off",
      },
    });
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
        timeoutMs: 50,
        config: {
          session: { store: storePath },
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

  it("recreates a missing bound thread and preserves auth plus turn overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
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
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: "fast",
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
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
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
    expect(requests[1]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[1]?.params.approvalPolicy).toBe("on-request");
    expect(requests[1]?.params.sandbox).toBe("workspace-write");
    expect(requests[1]?.params.serviceTier).toBe("priority");
    expect(requests[1]?.params).not.toHaveProperty("modelProvider");
    expect(requests[2]?.params.threadId).toBe("thread-new");
    expect(requests[2]?.params.approvalPolicy).toBe("on-request");
    expect(requests[2]?.params.serviceTier).toBe("priority");
    const savedBinding = await readTestConversationBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
    expect(savedBinding?.authProfileId).toBe("work");
    expect(savedBinding?.approvalPolicy).toBe("on-request");
    expect(savedBinding?.sandbox).toBe("workspace-write");
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
        requests.push({ method, params: requestParams });
        if (method === "thread/resume") {
          return conversationThreadStartResult("thread-target");
        }
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
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: "thread-target",
      cwd: tempDir,
      conversationStartId: "start-new",
    });
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
      workspaceDir: tempDir,
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
