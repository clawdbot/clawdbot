// Codex tests cover thread lifecycle.binding plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { resumeThread } from "../command-handler-bindings.js";
import { resolveCodexCommandDeps } from "../command-handler-deps.js";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import type { PluginAppPolicyContext } from "./plugin-thread-config.js";
import {
  isJsonObject,
  type CodexDynamicToolFunctionSpec,
  type JsonObject,
  type JsonValue,
  type RpcRequest,
} from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  resolveCodexNativeConfigFenceKey,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { fingerprintEnvironmentSelection } from "./thread-fingerprints.js";
import {
  buildThreadResumeParams,
  startOrResumeThread as startOrResumeThreadImpl,
} from "./thread-lifecycle.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import {
  releaseCodexAppServerBindingSubscription,
  withCodexAppServerThreadMutation,
} from "./thread-ownership.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";

function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  registerCodexTestSessionIdentity(
    params.params.sessionFile,
    params.params.sessionId,
    params.params.sessionKey,
  );
  return startOrResumeThreadImpl({
    signal: new AbortController().signal,
    ...params,
    bindingStore: testCodexAppServerBindingStore,
  });
}

function disabledMcpServerStatus(name: string) {
  return {
    name,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
  };
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

function createNetworkProxyThreadLifecycleAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "openclaw-network",
    permissions: {
      "openclaw-network": {
        filesystem: {
          ":minimal": "read",
          ":project_roots": {
            ".": "write",
          },
        },
        network: {
          enabled: true,
          domains: {
            "api.openai.com": "allow",
          },
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  };
  return {
    ...createThreadLifecycleAppServerOptions(),
    networkProxy: {
      profileName: "openclaw-network",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  };
}

function createParams(sessionFile: string, workspaceDir: string) {
  const params = createRunAttemptParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  return params;
}

const DEFAULT_CODEX_RUNTIME_THREAD_CONFIG = {
  project_doc_max_bytes: 131_072,
  "features.goals": false,
  "tools.update_plan.enabled": false,
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.apply_patch_streaming_events": true,
  suppress_unstable_features_warning: true,
  "features.standalone_web_search": false,
  web_search: "cached",
} as const;

const DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "cached",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding] = args;
  registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
  return writeRawCodexAppServerBinding(sessionFile, {
    webSearchThreadConfigFingerprint: DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    ...binding,
  });
}

function createMessageDynamicTool(
  description: string,
  actions: string[] = ["send"],
): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name: "message",
    description,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

function createNamedDynamicTool(name: string): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function createDeferredNamedDynamicTool(
  name: string,
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    type: "namespace",
    name: "openclaw",
    description: "",
    tools: [{ ...createNamedDynamicTool(name), deferLoading: true }],
  };
}

function createPluginAppConfigPatch(options: { approvalsReviewer?: "user" } = {}) {
  return {
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
        ...(options.approvalsReviewer ? { approvals_reviewer: options.approvalsReviewer } : {}),
      },
    },
  };
}

function createPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-1",
    apps: {
      "google-calendar-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: true,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app"],
    },
  };
}

function createTwoPluginAppConfigPatch() {
  return {
    apps: {
      ...createPluginAppConfigPatch().apps,
      "gmail-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

function createTwoPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-2",
    apps: {
      ...createPluginAppPolicyContext().apps,
      "gmail-app": {
        configKey: "gmail",
        marketplaceName: "openai-curated" as const,
        pluginName: "gmail",
        allowDestructiveActions: false,
        mcpServerNames: ["gmail"],
      },
    },
    pluginAppIds: {
      ...createPluginAppPolicyContext().pluginAppIds,
      gmail: ["gmail-app"],
    },
  };
}

function createTwoCalendarAppConfigPatch() {
  return {
    apps: {
      ...createPluginAppConfigPatch().apps,
      "google-calendar-secondary-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

function createTwoCalendarAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-calendar-2",
    apps: {
      ...createPluginAppPolicyContext().apps,
      "google-calendar-secondary-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: false,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app", "google-calendar-secondary-app"],
    },
  };
}

async function createManualResumeFixture(
  options: {
    active?: boolean;
    cold?: boolean;
    receipt?: "none" | "stale" | "unrelated" | "malformed";
    dynamicTools?: CodexDynamicToolFunctionSpec[];
    recordedTools?: JsonValue;
    missingMetadata?: boolean;
    omitCatalog?: boolean;
    competingLease?: "read" | "release" | "resume";
    wireClient?: boolean;
    parentControlledAfterAttach?: boolean;
  } = {},
) {
  const dynamicTools = options.dynamicTools ?? [];
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "isolated-state"));
  const sessionFile = path.join(tempDir, "manual-resume-session.jsonl");
  const workspaceDir = path.join(tempDir, "manual-resume-workspace");
  const agentDir = path.join(tempDir, "agent");
  const threadId = "thread-manual-resume";
  const rolloutPath = path.join(agentDir, "codex-home", "sessions", `rollout-${threadId}.jsonl`);
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, ...(options.omitCatalog ? {} : { dynamic_tools: options.recordedTools ?? dynamicTools }) } })}\n`,
  );
  if (options.missingMetadata) {
    await fs.rm(rolloutPath);
  }
  const response = threadStartResult(threadId, { cwd: workspaceDir });
  const thread = { ...response.thread, path: rolloutPath };
  let resumes = 0;
  const compete = () => {
    // Completed catalog/prewarm leases do not replace this physical thread owner.
    const release = retainSharedCodexAppServerClientIfCurrent(client);
    expect(release).toBeTypeOf("function");
    release?.();
  };
  const harness = createFakeCodexAppServerClient(async (method: string) => {
    if (method === "skills/list") {
      return { data: [{ cwd: workspaceDir, errors: [], skills: [] }] };
    }
    if (method === "thread/read") {
      if (options.competingLease === "read") {
        compete();
      }
      if (options.receipt === "stale") {
        await harness.notify({
          method: "thread/status/changed",
          params: { threadId, status: { type: "notLoaded" } },
        });
      }
      return {
        thread: {
          ...thread,
          ...(options.parentControlledAfterAttach && resumes > 0
            ? { canAcceptDirectInput: false }
            : {}),
          status: options.active
            ? { type: "active", activeFlags: [] }
            : { type: options.cold ? "notLoaded" : "idle" },
        },
      };
    }
    if (method === "thread/unsubscribe") {
      if (options.competingLease === "release") {
        compete();
      }
      return { status: "unsubscribed" };
    }
    if (method === "thread/resume") {
      if (resumes > 0 && options.competingLease === "resume") {
        compete();
      }
      if (resumes++ > 0 && options.receipt !== "none" && options.receipt !== "stale") {
        await harness.notify({
          method: "thread/status/changed",
          params: {
            threadId: options.receipt === "unrelated" ? "other-thread" : threadId,
            status: options.receipt === "malformed" ? null : { type: "notLoaded" },
          },
        });
      }
      return { ...response, thread };
    }
    if (method === "thread/inject_items") {
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const wire = options.wireClient ? createClientHarness() : undefined;
  const client = wire?.client ?? harness.client;
  if (wire) {
    // Keep the existing native response fixture behind the real wire client so
    // its async request guard and synchronous write edge remain under test.
    const appendWrites = wire.writes.push.bind(wire.writes);
    vi.spyOn(wire.writes, "push").mockImplementation((...messages) => {
      const count = appendWrites(...messages);
      for (const message of messages) {
        const request = JSON.parse(message) as RpcRequest;
        void Promise.resolve(harness.request(request.method, request.params)).then(
          (result) => wire.send({ id: request.id, result }),
          (error: unknown) =>
            wire.send({
              id: request.id,
              error: { code: -32603, message: String(error) },
            }),
        );
      }
      return count;
    });
    vi.spyOn(harness, "notify").mockImplementation(async (notification) => {
      wire.send(notification);
    });
    vi.spyOn(client, "initialize").mockResolvedValue(undefined);
  } else {
    Object.assign(client, {
      initialize: async () => undefined,
      // This fake closes and exits together; notify the pool's physical-client registry too.
      addTransportExitHandler: client.addCloseHandler.bind(client),
      setThreadSessionRequestGuard: () => undefined,
      close: () => harness.close(),
    });
  }
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(client);
  try {
    await getLeasedSharedCodexAppServerClient({
      startOptions: { ...createThreadLifecycleAppServerOptions().start, command: process.execPath },
      authProfileId: null,
      agentDir,
      config: {},
    });
  } finally {
    start.mockRestore();
  }
  const params = { ...createParams(sessionFile, workspaceDir), agentDir };
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
  const attach = () =>
    resumeThread(
      resolveCodexCommandDeps({
        bindingStore: testCodexAppServerBindingStore,
        codexControlRequest: async (_pluginConfig, method, requestParams, requestOptions) => {
          await requestOptions?.beforeRequest?.(
            <T>({
              method: preflightMethod,
              requestParams: preflightParams,
            }: {
              method: string;
              requestParams?: unknown;
            }) => client.request<T>(preflightMethod, preflightParams, { timeoutMs: 60_000 }),
            client,
            { assertCurrent: () => undefined },
          );
          const result = await client.request<JsonValue>(method, requestParams, {
            timeoutMs: 60_000,
          });
          await requestOptions?.onResponse?.(result, client, {
            authProfileId: undefined,
            assertCurrent: () => undefined,
          });
          return result;
        },
      }),
      {
        channel: "test",
        isAuthorizedSender: true,
        senderIsOwner: true,
        commandBody: `/codex resume ${threadId}`,
        config: {},
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      undefined,
      [threadId],
    );
  await attach();
  const common = {
    client,
    params,
    cwd: workspaceDir,
    dynamicTools,
    appServer: createThreadLifecycleAppServerOptions(),
    userMcpServersEnabled: false,
  };
  return {
    ...harness,
    attach,
    client,
    wire,
    close: () => {
      releaseLeasedSharedCodexAppServerClient(client);
      if (wire) {
        wire.client.close();
      } else {
        harness.close();
      }
    },
    common,
    sessionFile,
    threadId,
    identity: {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    },
    start: (overrides: Partial<Parameters<typeof startOrResumeThread>[0]> = {}) =>
      startOrResumeThread({ ...common, ...overrides }),
  };
}

setupRunAttemptTestHooks();

async function createLeasedLifecycleWireClient(
  agentDir: string,
  respond: (request: RpcRequest) => unknown,
) {
  const wire = createClientHarness();
  const appendWrites = wire.writes.push.bind(wire.writes);
  vi.spyOn(wire.writes, "push").mockImplementation((...messages) => {
    const count = appendWrites(...messages);
    for (const message of messages) {
      const request = JSON.parse(message) as RpcRequest;
      void Promise.resolve()
        .then(() => respond(request))
        .then(
          (result) => wire.send({ id: request.id, result }),
          (error: unknown) =>
            wire.send({
              id: request.id,
              error:
                error instanceof CodexAppServerRpcError
                  ? { code: error.code, message: error.message }
                  : { code: -32603, message: String(error) },
            }),
        );
    }
    return count;
  });
  vi.spyOn(wire.client, "initialize").mockResolvedValue(undefined);
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(wire.client);
  try {
    await getLeasedSharedCodexAppServerClient({
      startOptions: { ...createThreadLifecycleAppServerOptions().start, command: process.execPath },
      authProfileId: null,
      agentDir,
      config: {},
    });
  } finally {
    start.mockRestore();
  }
  // Preserve the wire harness's live transport getters.
  return Object.assign(wire, {
    start: (sessionFile: string, workspaceDir: string) =>
      startOrResumeThread({
        client: wire.client,
        params: { ...createParams(sessionFile, workspaceDir), agentDir },
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
      }),
  });
}

describe("Codex app-server thread lifecycle bindings", () => {
  it.each([false, true])(
    "resumes idle A with current policy while B stays active and catalog leases come and go (native model: %s)",
    async (nativeModelOwned) => {
      const sessionFile = path.join(tempDir, "parallel-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "parallel-policy-a";
      const siblingId = "parallel-policy-b";
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "thread/resume") {
            const reader = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
            try {
              await reader.request("thread/read", { threadId: siblingId, includeTurns: false });
            } finally {
              releaseLeasedSharedCodexAppServerClient(reader);
            }
            return threadStartResult(threadId);
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      fixture.seed(threadStartResult(threadId), { loaded: true, subscribed: false });
      const siblingResponse = threadStartResult(siblingId);
      fixture.seed(
        {
          ...siblingResponse,
          thread: { ...siblingResponse.thread, status: { type: "active", activeFlags: [] } },
        },
        { loaded: true, subscribed: true },
      );
      const nativeModel = threadStartResult(threadId);
      await writeCodexAppServerBinding(sessionFile, {
        threadId,
        cwd: workspaceDir,
        preserveNativeModel: nativeModelOwned ? true : undefined,
        ...(nativeModelOwned
          ? { model: nativeModel.model, modelProvider: nativeModel.modelProvider }
          : {}),
      });
      const params = createParams(sessionFile, workspaceDir);
      if (nativeModelOwned) {
        params.expectedSessionRuntimeOwnership = {
          model: "native",
          auth: "host",
          modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
        };
      }
      const sibling = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
      const siblingClaim = await claimCodexAppServerLiveThread(sibling, siblingId);
      try {
        const resumed = await startOrResumeThread({
          client: fixture.client,
          params,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          userMcpServersEnabled: false,
          developerInstructions: "current A policy",
        });
        expect(resumed).toMatchObject({ threadId, lifecycle: { action: "resumed" } });
        const binding = await readCodexAppServerBinding(sessionFile);
        expect(binding?.threadId).toBe(threadId);
        expect(binding?.preserveNativeModel).toBe(nativeModelOwned ? true : undefined);
        const injection = fixture.request.mock.calls.find(
          ([method]) => method === "thread/inject_items",
        );
        expect(JSON.stringify(injection?.[1])).toContain("current A policy");
        expect(siblingClaim).toBeDefined();
        expect(() => siblingClaim!.assertCurrent()).not.toThrow();
        await expect(
          sibling.request("thread/read", { threadId: siblingId, includeTurns: false }),
        ).resolves.toMatchObject({ thread: { status: { type: "active" } } });
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect(fixture.client.getCloseError()).toBeUndefined();
      } finally {
        await siblingClaim?.release(siblingId);
        releaseLeasedSharedCodexAppServerClient(sibling);
      }
    },
  );

  it("accounts for 100 seeded rounds across eight native thread owners without leaked or stale claims", async () => {
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "stress-agent"),
      respond: async (method, requestParams) => {
        if (
          method === "thread/resume" &&
          isJsonObject(requestParams) &&
          typeof requestParams.threadId === "string"
        ) {
          return threadStartResult(requestParams.threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const runs = Array.from({ length: 8 }, (_, index) => {
      const sessionId = `stress-session-${index}`;
      const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
      const params = {
        ...createParams(sessionFile, tempDir),
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
      };
      registerCodexTestSessionIdentity(sessionFile, sessionId, params.sessionKey);
      return { params, threadId: `stress-thread-${index}`, completed: 0 };
    });
    for (const run of runs) {
      fixture.seed(threadStartResult(run.threadId));
      await writeRawCodexAppServerBinding(run.params.sessionFile, {
        threadId: run.threadId,
        cwd: tempDir,
        webSearchThreadConfigFingerprint: DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      });
    }
    let seed = 0x136143;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let round = 0; round < 100; round++) {
      const ordered = runs
        .map((run) => ({ run, order: next() }))
        .toSorted((a, b) => a.order - b.order);
      const outcomes = await Promise.allSettled(
        ordered.map(async ({ run, order }) => {
          const client = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
          try {
            if (order % 2 === 0) {
              const prewarm = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
              releaseLeasedSharedCodexAppServerClient(prewarm);
            }
            const entered = createDeferred<void>();
            const proceed = createDeferred<void>();
            const predecessor = withCodexAppServerThreadMutation(run.threadId, async () => {
              entered.resolve();
              await proceed.promise;
            });
            await entered.promise;
            const preparing = startOrResumeThread({
              client,
              params: run.params,
              cwd: tempDir,
              dynamicTools: [],
              appServer: createThreadLifecycleAppServerOptions(),
              userMcpServersEnabled: false,
              developerInstructions: `policy round ${round}`,
            });
            await withCodexAppServerThreadMutation(`stress-independent-${round}`, async () => {});
            proceed.resolve();
            const binding = await preparing;
            await predecessor;
            expect(binding.threadId).toBe(run.threadId);
            const first = await claimCodexAppServerLiveThread(client, run.threadId);
            expect(first).toBeDefined();
            expect(await retainCodexAppServerLiveThread(client, run.threadId, first!.release)).toBe(
              true,
            );
            const successor = await claimCodexAppServerLiveThread(client, run.threadId);
            expect(successor).toBeDefined();
            await first!.release(run.threadId);
            successor!.assertCurrent();
            await successor!.release(run.threadId);
            expect(isCodexAppServerLiveThreadClaimed(client, run.threadId)).toBe(false);
            run.completed++;
          } finally {
            releaseLeasedSharedCodexAppServerClient(client);
          }
        }),
      );
      expect(
        outcomes.every((outcome) => outcome.status === "fulfilled"),
        JSON.stringify(outcomes),
      ).toBe(true);
    }
    expect(runs.map((run) => run.completed)).toEqual(Array(8).fill(100));
    for (const method of ["thread/resume", "thread/inject_items", "thread/unsubscribe"]) {
      expect(
        fixture.request.mock.calls.filter(([called]) => called === method),
        method,
      ).toHaveLength(800);
    }
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    releaseLeasedSharedCodexAppServerClient(fixture.client);
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(fixture.client)).toEqual({
      found: true,
      closed: true,
      activeLeases: 0,
      pendingAcquires: 0,
    });
  });

  it("exposes incognito policy refusal as an unscoped preflight", () => {
    const error = new CodexIncognitoPolicyChangeError();
    expect(error).toBeInstanceOf(AgentHarnessPreflightError);
    expect(error).toMatchObject({ scope: undefined });
  });
  it.each([
    { developerInstructions: "replacement policy", fault: "none" },
    { developerInstructions: "", fault: "none" },
    { developerInstructions: "replacement policy", fault: "unload" },
    { developerInstructions: "replacement policy", fault: "client retired" },
    { developerInstructions: "replacement policy", fault: "unknown write" },
    { developerInstructions: "replacement policy", fault: "retirement failure" },
    { developerInstructions: "replacement policy", fault: "binding commit" },
  ])(
    "refreshes ordinary generic policy before admitting a resumed turn: $developerInstructions / $fault",
    async ({ developerInstructions, fault }) => {
      const sessionFile = path.join(tempDir, "ordinary-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-policy";
      const response = threadStartResult(threadId);
      const requests: RpcRequest[] = [];
      const wire = await createLeasedLifecycleWireClient(path.join(tempDir, "agent"), (request) => {
        requests.push(request);
        if (request.method === "thread/read") {
          return {
            thread: {
              ...response.thread,
              status: { type: fault === "unload" ? "idle" : "notLoaded" },
            },
          };
        }
        if (request.method === "thread/resume") {
          if (fault === "client retired") {
            retireSharedCodexAppServerClientIfCurrent(wire.client);
          }
          return response;
        }
        if (request.method === "thread/inject_items") {
          if (fault === "unknown write" || fault === "retirement failure") {
            throw new CodexAppServerRpcError(
              { code: -32603, message: "policy flush failed after write" },
              "thread/inject_items",
            );
          }
          return {};
        }
        if (request.method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        throw new Error(`unexpected method: ${request.method}`);
      });
      await writeCodexAppServerBinding(sessionFile, { threadId, cwd: workspaceDir });
      const before = await readCodexAppServerBinding(sessionFile);
      if (fault === "binding commit") {
        vi.spyOn(testCodexAppServerBindingStore, "mutate").mockRejectedValueOnce(
          new Error("binding commit failed"),
        );
      }
      try {
        const run = startOrResumeThread({
          client: wire.client,
          params: {
            ...createParams(sessionFile, workspaceDir),
            agentDir: path.join(tempDir, "agent"),
          },
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          userMcpServersEnabled: false,
          developerInstructions,
          signal: new AbortController().signal,
          ...(fault === "retirement failure"
            ? {
                abandonClient: async () => {
                  throw new Error("client retirement failed");
                },
              }
            : {}),
        });
        if (fault !== "none") {
          await expect(run).rejects.toBeInstanceOf(AgentHarnessPreflightError);
          await expect(run).rejects.toMatchObject({
            name: "CodexThreadPolicyHandoffError",
            scope: undefined,
            outcome:
              fault === "unknown write" || fault === "retirement failure"
                ? "unknown"
                : fault === "binding commit"
                  ? "acknowledged"
                  : "not-written",
          });
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
          expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
          expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(
            fault === "unknown write" ||
              fault === "retirement failure" ||
              fault === "binding commit"
              ? 1
              : 0,
          );
          expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
          return;
        }
        await run;
        expect(requests.map(({ method }) => method)).toEqual([
          "thread/read",
          "thread/resume",
          "thread/inject_items",
        ]);
        const policy = JSON.stringify(requests.at(-1)?.params);
        expect(policy).toContain(
          developerInstructions || "earlier OpenClaw generic policy is withdrawn",
        );
        expect(policy).toContain("It replaces earlier OpenClaw-supplied generic policy");
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(threadId);
      } finally {
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );

  it.each(["initial policy", "replacement policy", ""])(
    "keeps ordinary warm configuration honest across policy %j",
    async (developerInstructions) => {
      const sessionFile = path.join(tempDir, "ordinary-warm-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-warm-policy";
      const response = threadStartResult(threadId);
      const methods: string[] = [];
      const wire = await createLeasedLifecycleWireClient(path.join(tempDir, "agent"), (request) => {
        methods.push(request.method);
        if (request.method === "thread/start" || request.method === "thread/resume") {
          return response;
        }
        if (request.method === "thread/read") {
          return { thread: response.thread };
        }
        if (request.method === "thread/unsubscribe") {
          wire.send({
            method: "thread/status/changed",
            params: { threadId, status: { type: "notLoaded" } },
          });
          return { status: "unsubscribed" };
        }
        if (request.method === "thread/inject_items") {
          return {};
        }
        throw new Error(`unexpected method: ${request.method}`);
      });
      const common = {
        client: wire.client,
        params: {
          ...createParams(sessionFile, workspaceDir),
          agentDir: path.join(tempDir, "agent"),
        },
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
      };
      try {
        const first = await startOrResumeThread({
          ...common,
          developerInstructions: "initial policy",
        });
        await retainCodexAppServerLiveThread(
          wire.client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const second = await startOrResumeThread({ ...common, developerInstructions });
        expect(second.threadId).toBe(first.threadId);
        expect(methods).toEqual(
          developerInstructions === "initial policy"
            ? ["thread/start"]
            : [
                "thread/start",
                "thread/read",
                "thread/unsubscribe",
                "thread/resume",
                "thread/inject_items",
              ],
        );
      } finally {
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );

  it("persists the native rollout path across thread start and resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const threadId = "thread-native-rollout";
    const rolloutPath = path.join(
      tempDir,
      "agent",
      "codex-home",
      "sessions",
      `rollout-${threadId}.jsonl`,
    );
    const params = createParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string) => {
      if (method !== "thread/start" && method !== "thread/resume") {
        throw new Error(`unexpected method: ${method}`);
      }
      const response = threadStartResult(threadId);
      return {
        ...response,
        thread: { ...response.thread, path: rolloutPath },
      };
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const started = await startOrResumeThread(common);
    expect(started).toMatchObject({
      threadId,
      rolloutPath,
      lifecycle: { action: "started" },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId,
      rolloutPath,
    });

    await fixture.endTurn("thread-native-rollout");
    const resumed = await startOrResumeThread(common);
    expect(resumed).toMatchObject({
      threadId,
      rolloutPath,
      lifecycle: { action: "resumed" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId,
      rolloutPath,
    });
  });

  it("reuses only an explicitly retained subscription on the original client", async () => {
    const sessionFile = path.join(tempDir, "warm-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const buildFinalConfigPatch = vi
      .fn()
      .mockReturnValueOnce({ nativeHookRelayGeneration: "generation-warm" })
      .mockReturnValueOnce({ nativeHookRelayGeneration: "generation-warm-next" });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
      buildFinalConfigPatch,
    };

    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const reused = await startOrResumeThread(common);

    expect(started).toMatchObject({
      clientId: "client-warm",
      threadId: "thread-warm",
      nativeHookRelayGeneration: "generation-warm",
      lifecycle: { action: "started" },
    });
    expect(reused).toMatchObject({
      clientId: "client-warm",
      threadId: "thread-warm",
      nativeHookRelayGeneration: "generation-warm-next",
      lifecycle: { action: "resumed" },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      nativeHookRelayGeneration: "generation-warm-next",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(buildFinalConfigPatch).toHaveBeenNthCalledWith(1, { action: "start" });
    expect(buildFinalConfigPatch).toHaveBeenNthCalledWith(2, {
      action: "resume",
      binding: expect.objectContaining({ threadId: "thread-warm" }),
    });
  });

  it.each(
    [false, true].flatMap((incognito) =>
      ["plugin config", "app attestation"].flatMap((stage) =>
        ["thread/closed", "thread/archived", "host"].map((revocation) => ({
          incognito,
          stage,
          revocation,
        })),
      ),
    ),
  )(
    "refuses revoked warm ownership during $stage ($revocation, incognito: $incognito)",
    async ({ incognito, stage, revocation }) => {
      const sessionFile = path.join(tempDir, "warm-revocation.jsonl");
      const workspaceDir = path.join(tempDir, "warm-revocation-workspace");
      const params = createParams(sessionFile, workspaceDir);
      if (incognito) {
        params.sessionKey = "agent:main:dashboard:incognito-warm-revocation";
      }
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const entered = createDeferred<void>();
      const proceed = createDeferred<void>();
      let warming = false;
      const pause = async (currentStage: string) => {
        if (warming && stage === currentStage) {
          entered.resolve();
          await proceed.promise;
        }
      };
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "thread/start") {
            return threadStartResult("warm-revoked");
          }
          if (method === "app/installed") {
            await pause("app attestation");
            return { apps: [{ id: "fixture-app", enabled: true, callable: true }] };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const { client, request } = fixture;
      const abandonClient = vi.fn(async () => {});
      const common = {
        client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        abandonClient,
        nativeHookRelayGeneration: "original-relay",
        pluginThreadConfig: {
          enabled: true,
          requiresCurrentPolicyCheck: true,
          inputFingerprint: "warm-app-input",
          build: async () => {
            await pause("plugin config");
            return {
              enabled: true,
              fingerprint: "warm-app-config",
              inputFingerprint: "warm-app-input",
              diagnostics: [],
              configPatch: createPluginAppConfigPatch(),
              policyContext: createPluginAppPolicyContext(),
              provisionalAppIds: ["fixture-app"],
            };
          },
        },
      };
      const started = await startOrResumeThread(common);
      await retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
        null,
        started.liveThreadEphemeralPolicy,
      );
      fixture.seed(threadStartResult("sibling"), { loaded: true, subscribed: true });
      const sibling = await claimCodexAppServerLiveThread(client, "sibling");
      expect(sibling).toBeDefined();
      const before = await readCodexAppServerBinding(sessionFile);
      request.mockClear();
      warming = true;
      const pending = startOrResumeThread({
        ...common,
        nativeHookRelayGeneration: "stale-refresh",
      });
      await entered.promise;
      expect(isCodexAppServerLiveThreadClaimed(client, started.threadId)).toBe(true);
      expect(request.mock.calls.some(([method]) => method.startsWith("thread/"))).toBe(false);
      let successor: typeof sibling;
      if (revocation === "host") {
        closeHost();
      } else {
        fixture.notify({
          method: revocation as "thread/closed" | "thread/archived",
          params: { threadId: started.threadId },
        });
        successor = await claimCodexAppServerLiveThread(client, started.threadId);
        expect(successor).toBeDefined();
      }
      proceed.resolve();
      const error = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AgentHarnessPreflightError);
      expect(error).toMatchObject({
        name: "AgentHarnessPreflightError",
        scope: undefined,
        message: expect.stringContaining("reconnect before continuing"),
      });
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
      expect(() => sibling!.assertCurrent()).not.toThrow();
      if (successor) {
        expect(() => successor.assertCurrent()).not.toThrow();
      }
      expect(
        request.mock.calls
          .filter(([method]) => method.startsWith("thread/"))
          .map(([method, requestParams]) => [method, requestParams]),
      ).toEqual(
        revocation === "host" ? [["thread/unsubscribe", { threadId: started.threadId }]] : [],
      );
      expect(abandonClient).not.toHaveBeenCalled();
      expect(client.getCloseError()).toBeUndefined();
    },
  );

  it("cold-resumes a warm thread to clear stale enforcing PreToolUse hooks", async () => {
    const sessionFile = path.join(tempDir, "warm-cleared-hooks-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-cleared-hooks-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const fake = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method: string) => {
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult("thread-warm-cleared-hooks");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const client = fake.client;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const buildFinalConfigPatch = vi
      .fn()
      .mockReturnValueOnce({
        configPatch: {
          "features.hooks": true,
          "hooks.PreToolUse": [
            {
              hooks: [
                {
                  type: "command",
                  command: "openclaw hooks relay --event pre_tool_use",
                },
              ],
            },
          ],
        },
        nativeHookRelayGeneration: "generation-policy",
      })
      .mockReturnValueOnce({
        configPatch: { "features.hooks": true, "hooks.PreToolUse": [] },
        nativeHookRelayGeneration: "generation-no-policy",
      });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
      buildFinalConfigPatch,
    };

    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const resumed = await startOrResumeThread(common);

    expect(resumed).toMatchObject({
      threadId: "thread-warm-cleared-hooks",
      nativeHookRelayGeneration: "generation-no-policy",
      lifecycle: { action: "resumed" },
    });
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "thread/inject_items",
    ]);
    const resumeConfig = fake.request.mock.calls.find(
      ([method]) => method === "thread/resume",
    )?.[1];
    expect(resumeConfig).toMatchObject({
      config: { "features.hooks": true, "hooks.PreToolUse": [] },
    });
    expect(JSON.stringify(resumeConfig)).not.toContain("openclaw hooks relay");
  });

  it("cold-resumes a warm thread when final config adds an image-generation deny", async () => {
    const sessionFile = path.join(tempDir, "warm-image-deny-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-image-deny-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-image-deny");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
    const resumed = await startOrResumeThread(common);

    expect(resumed).toMatchObject({
      threadId: "thread-warm-image-deny",
      lifecycle: { action: "resumed" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "configRequirements/read",
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
      config: { "features.image_generation": false },
    });
  });

  it("keeps a warm native session across sticky environment selection changes", async () => {
    const sessionFile = path.join(tempDir, "environment-session.jsonl");
    const workspaceDir = path.join(tempDir, "environment-workspace");
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-environments");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-environments",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const firstSelection = [{ environmentId: "environment-a", cwd: workspaceDir }];
    const secondSelection = [{ environmentId: "environment-b", cwd: workspaceDir }];

    const started = await startOrResumeThread({
      ...common,
      environmentSelection: firstSelection,
    });
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const switched = await startOrResumeThread({
      ...common,
      environmentSelection: secondSelection,
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-environments",
      environmentSelectionFingerprint: fingerprintEnvironmentSelection(secondSelection),
    });
    await expect(
      retainCodexAppServerLiveThread(
        client,
        switched.threadId,
        switched.liveThreadOwnership?.release,
        switched.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const restored = await startOrResumeThread({
      ...common,
      environmentSelection: firstSelection,
    });

    expect(switched.threadId).toBe(started.threadId);
    expect(restored.threadId).toBe(started.threadId);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      environmentSelectionFingerprint: fingerprintEnvironmentSelection(firstSelection),
    });
  });

  it("rebinds a resumed thread to its replacement physical client before warm reuse", async () => {
    const sessionFile = path.join(tempDir, "replacement-client-session.jsonl");
    const workspaceDir = path.join(tempDir, "replacement-client-workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-reused",
      clientId: "client-before-restart",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
    });
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-reused");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-reused"],
    });
    const { client, request } = fixture;
    const common = {
      client,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const resumed = await startOrResumeThread(common);

    expect(resumed.clientId).toBe(client.getInstanceId());
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-reused",
      clientId: client.getInstanceId(),
    });
    await retainCodexAppServerLiveThread(
      client,
      resumed.threadId,
      undefined,
      resumed.liveThreadConfigFingerprint,
    );
    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: "thread-reused",
      clientId: client.getInstanceId(),
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it.each([
    {
      label: "loaded native thread",
      options: { dynamicTools: [createNamedDynamicTool("example")] },
    },
    {
      label: "cold native thread with no stored tools",
      options: { cold: true, omitCatalog: true, receipt: "none" as const },
    },
  ])(
    "configures the actual manual-resume binding without replacing its native thread: $label",
    async ({ options }) => {
      const fixture = await createManualResumeFixture(options);
      try {
        const resumed = await fixture.start();
        expect(resumed).toMatchObject({
          threadId: fixture.threadId,
          clientId: fixture.client.getInstanceId(),
          lifecycle: { action: "resumed" },
        });
        expect(
          (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
        ).toBeUndefined();
        expect(
          fixture.request.mock.calls
            .map(([method]) => method)
            .filter((method) => method !== "skills/list"),
        ).toEqual([
          "thread/read",
          "thread/resume",
          "thread/read",
          "thread/unsubscribe",
          "thread/resume",
          "thread/inject_items",
        ]);
      } finally {
        fixture.close();
      }
    },
  );

  it.each([
    { options: { receipt: "none" as const }, error: "did not confirm unloading" },
    { options: { receipt: "unrelated" as const }, error: "did not confirm unloading" },
    { options: { receipt: "stale" as const }, error: "did not confirm unloading" },
    { options: { receipt: "malformed" as const }, error: "did not confirm unloading" },
    { options: { missingMetadata: true }, error: "tool catalog could not be read" },
    { options: { recordedTools: { invalid: true } }, error: "immutable native tool catalog" },
    {
      options: { recordedTools: [createNamedDynamicTool("old-tool")] },
      error: "immutable native tool catalog",
    },
    { options: { active: true }, error: "native thread is not idle" },
    {
      options: { parentControlledAfterAttach: true },
      error: "controlled by its parent",
    },
  ])(
    "preserves pending manual resume when native configuration cannot be attested: $options",
    async ({ options, error }) => {
      const fixture = await createManualResumeFixture(options);
      const before = await readCodexAppServerBinding(fixture.sessionFile);
      const handlers = fixture.notifications.length;
      try {
        await expect(fixture.start()).rejects.toThrow(error);
        expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect(fixture.notifications).toHaveLength(handlers);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["claimed", "sibling"] as const)(
    "does not unsubscribe a pending manual-resume thread owned by %s work",
    async (owner) => {
      const fixture = await createManualResumeFixture();
      try {
        if (owner === "claimed") {
          await claimCodexAppServerLiveThread(fixture.client, fixture.threadId);
        } else {
          await testCodexAppServerBindingStore.mutate(
            { kind: "conversation", bindingId: "surviving-conversation" },
            {
              kind: "set",
              binding: {
                threadId: fixture.threadId,
                clientId: fixture.client.getInstanceId(),
                cwd: fixture.common.cwd,
              },
            },
          );
        }
        const before = await readCodexAppServerBinding(fixture.sessionFile);
        await expect(fixture.start()).rejects.toThrow(
          owner === "claimed" ? "claimed by active work" : "owned by another",
        );
        expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        expect(
          fixture.request.mock.calls
            .map(([method]) => method)
            .filter((method) => method !== "skills/list"),
        ).toEqual(["thread/read", "thread/resume"]);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["remote", "user-home", "transient", "unknown-search"] as const)(
    "preserves pending manual resume outside its supported configuration scope: %s",
    async (scope) => {
      const fixture = await createManualResumeFixture();
      try {
        const overrides: Partial<Parameters<typeof startOrResumeThread>[0]> =
          scope === "transient"
            ? { nativeCodeModeEnabled: false }
            : scope === "unknown-search"
              ? { nativeProviderWebSearchSupport: "unknown" }
              : {
                  appServer: {
                    ...fixture.common.appServer,
                    start: {
                      ...fixture.common.appServer.start,
                      ...(scope === "remote" ? { transport: "websocket" } : { homeScope: "user" }),
                    },
                  },
                };
        const before = await readCodexAppServerBinding(fixture.sessionFile);
        await expect(fixture.start(overrides)).rejects.toThrow(
          "Cannot configure resumed Codex thread",
        );
        expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        expect(
          fixture.request.mock.calls.some(
            ([method]) => method === "thread/start" || method === "thread/unsubscribe",
          ),
        ).toBe(false);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["read", "release", "resume"] as const)(
    "keeps manual resume configuration across unrelated client leases during %s",
    async (competingLease) => {
      const fixture = await createManualResumeFixture({ cold: true, competingLease });
      try {
        await expect(fixture.start()).resolves.toMatchObject({ threadId: fixture.threadId });
        expect(
          (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
        ).toBeUndefined();
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "thread/inject_items"),
        ).toHaveLength(1);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["reader", "retired"] as const)(
    "checks physical ownership after a %s interleaves behind the native config fence",
    async (interleaving) => {
      const fixture = await createManualResumeFixture({ wireClient: true });
      const before = await readCodexAppServerBinding(fixture.sessionFile);
      const fenceKey = resolveCodexNativeConfigFenceKey({ client: fixture.client });
      expect(fenceKey).toBeTypeOf("string");
      const releaseFence = await acquireCodexNativeConfigFence(fenceKey!);
      const guardEntered = createDeferred<void>();
      const abort = new AbortController();
      fixture.client.setThreadSessionRequestGuard(async (options) => {
        guardEntered.resolve();
        return await acquireCodexNativeConfigFence(fenceKey!, options);
      });
      const starting = fixture.start({ signal: abort.signal });
      const settled = starting.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          guardEntered.promise,
          settled.then(() => {
            throw new Error("manual resume settled before reaching its native config fence");
          }),
        ]);
        const releaseSibling = retainSharedCodexAppServerClientIfCurrent(fixture.client);
        expect(releaseSibling).toBeTypeOf("function");
        releaseSibling?.();
        if (interleaving === "retired") {
          retireSharedCodexAppServerClientIfCurrent(fixture.client);
        }
        releaseFence();

        if (interleaving === "retired") {
          await expect(starting).rejects.toThrow("connection changed");
          expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        } else {
          await expect(starting).resolves.toMatchObject({ threadId: fixture.threadId });
          expect(
            (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
          ).toBeUndefined();
        }
        expect(fixture.client.getCloseError()).toBeUndefined();
        expect(
          fixture
            .wire!.writes.map((message) => (JSON.parse(message) as RpcRequest).method)
            .filter((method) => method === "thread/resume"),
        ).toEqual(
          interleaving === "retired" ? ["thread/resume"] : ["thread/resume", "thread/resume"],
        );
      } finally {
        abort.abort();
        releaseFence();
        await settled;
        fixture.close();
      }
    },
  );

  it.each(["attach", "release", "reset"] as const)(
    "queues same-thread %s behind ordinary preparation without blocking siblings",
    async (operation) => {
      const fixture = await createManualResumeFixture({ wireClient: true });
      await fixture.start();
      fixture.wire!.writes.length = 0;
      const entered = createDeferred<void>();
      const proceed = createDeferred<void>();
      fixture.client.setThreadSessionRequestGuard(async () => {
        entered.resolve();
        await proceed.promise;
        return () => {};
      });
      const starting = fixture.start();
      const settledStart = Promise.allSettled([starting]);
      let mutation: Promise<unknown> | undefined;
      try {
        await Promise.race([
          entered.promise,
          settledStart.then(() => {
            throw new Error("resume failed before its write fence");
          }),
        ]);
        mutation =
          operation === "attach"
            ? fixture.attach()
            : operation === "reset"
              ? retireCodexAppServerSessionGeneration({
                  bindingStore: testCodexAppServerBindingStore,
                  identity: fixture.identity,
                  mode: "reset",
                })
              : withCodexAppServerThreadMutation(fixture.threadId, () =>
                  testCodexAppServerBindingStore.withLease(fixture.identity, async () => {
                    const binding = testCodexAppServerBindingStore.read(fixture.identity);
                    if (binding) {
                      await releaseCodexAppServerBindingSubscription(binding, {
                        allowUntracked: true,
                      });
                    }
                  }),
                );
        let mutationSettled = false;
        const settledMutation = mutation.finally(() => {
          mutationSettled = true;
        });
        const results = Promise.allSettled([starting, settledMutation]);
        await withCodexAppServerThreadMutation("unrelated-thread", async () => {});
        expect(mutationSettled).toBe(false);
        proceed.resolve();
        for (const result of await results) {
          expect(
            result.status,
            result.status === "rejected" ? String(result.reason) : operation,
          ).toBe("fulfilled");
        }
        const methods = fixture.wire!.writes.map((line) => (JSON.parse(line) as RpcRequest).method);
        expect(methods.indexOf("thread/inject_items")).toBeGreaterThan(
          methods.lastIndexOf("thread/read", methods.indexOf("thread/inject_items")),
        );
        expect((await readCodexAppServerBinding(fixture.sessionFile))?.threadId).toBe(
          operation === "reset" ? undefined : fixture.threadId,
        );
      } finally {
        proceed.resolve();
        await Promise.allSettled([starting, mutation]);
        fixture.close();
      }
    },
  );

  it.each([
    { pending: true, change: "delete", nativeModelOwned: false },
    { pending: false, change: "delete", nativeModelOwned: false },
    { pending: false, change: "replace-client", nativeModelOwned: false },
    { pending: false, change: "replace-thread", nativeModelOwned: false },
    { pending: false, change: "delete", nativeModelOwned: true },
    { pending: false, change: "replace-client", nativeModelOwned: true },
    { pending: false, change: "replace-thread", nativeModelOwned: true },
  ])(
    "rejects a changed binding queued for preparation ($change, manual intent: $pending, native model: $nativeModelOwned)",
    async ({ pending, change, nativeModelOwned }) => {
      const fixture = await createManualResumeFixture();
      const nativeModel = threadStartResult(fixture.threadId);
      if (!pending) {
        await testCodexAppServerBindingStore.mutate(fixture.identity, {
          kind: "patch",
          threadId: fixture.threadId,
          patch: {
            pendingResumeConfiguration: undefined,
            preserveNativeModel: nativeModelOwned ? true : undefined,
            ...(nativeModelOwned
              ? { model: nativeModel.model, modelProvider: nativeModel.modelProvider }
              : {}),
          },
        });
      }
      if (nativeModelOwned) {
        fixture.common.params.expectedSessionRuntimeOwnership = {
          model: "native",
          auth: "host",
          modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
        };
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const blocker = withCodexAppServerThreadMutation(fixture.threadId, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const readBinding = testCodexAppServerBindingStore.read.bind(testCodexAppServerBindingStore);
      const read = vi.spyOn(testCodexAppServerBindingStore, "read");
      const pendingRead = createDeferred<void>();
      read.mockImplementationOnce((identity) => {
        const binding = readBinding(identity);
        pendingRead.resolve();
        return binding;
      });
      const starting = fixture.start();
      try {
        await pendingRead.promise;
        const current = await readCodexAppServerBinding(fixture.sessionFile);
        expect(current).toBeDefined();
        await testCodexAppServerBindingStore.mutate(
          fixture.identity,
          change === "delete"
            ? { kind: "clear", threadId: fixture.threadId }
            : {
                kind: "set",
                binding: {
                  ...current!,
                  ...(change === "replace-client"
                    ? { clientId: "replacement-client" }
                    : { threadId: "replacement-thread" }),
                },
              },
        );
        release.resolve();
        await expect(starting).rejects.toThrow(
          nativeModelOwned && change === "delete"
            ? "native session ownership is missing or changed"
            : "acquiring thread lifecycle ownership",
        );
        expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
          "thread/read",
          "thread/resume",
        ]);
      } finally {
        release.resolve();
        await blocker;
        read.mockRestore();
        fixture.close();
      }
    },
  );

  it("reuses an isolated retained thread without dropping native skill isolation", async () => {
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "isolated-state"));
    const sessionFile = path.join(tempDir, "warm-isolated-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-isolated-workspace");
    const personalSkill = path.join(tempDir, ".claude", "skills", "personal", "SKILL.md");
    await fs.mkdir(path.dirname(personalSkill), { recursive: true });
    await fs.writeFile(personalSkill, "personal");
    const personalSkillRealPath = await fs.realpath(personalSkill);
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: workspaceDir,
              errors: [],
              skills: [
                {
                  name: "personal",
                  description: "Personal skill",
                  path: personalSkillRealPath,
                  scope: "user",
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-warm-isolated");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-isolated",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: "thread-warm-isolated",
      lifecycle: { action: "resumed" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["skills/list", "thread/start"]);
    const startRequest = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startRequest).toMatchObject({
      config: {
        "skills.include_instructions": false,
        "skills.config": [{ path: personalSkillRealPath, enabled: false }],
      },
    });
  });

  it("refreshes model and workspace ownership when reusing a turn-mutable native session", async () => {
    const sessionFile = path.join(tempDir, "warm-model-workspace.jsonl");
    const originalWorkspace = path.join(tempDir, "workspace-original");
    const currentWorkspace = path.join(tempDir, "workspace-current");
    const params = createParams(sessionFile, originalWorkspace);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm-model-workspace", { cwd: originalWorkspace });
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-model-workspace",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: originalWorkspace });
    const common = {
      client,
      params,
      cwd: originalWorkspace,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );
    params.modelId = "gpt-5.5";
    params.workspaceDir = currentWorkspace;

    const reused = await startOrResumeThread({ ...common, cwd: currentWorkspace });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(reused).toMatchObject({
      threadId: "thread-warm-model-workspace",
      cwd: currentWorkspace,
      model: "gpt-5.5",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      cwd: currentWorkspace,
      model: "gpt-5.5",
    });
  });

  it("releases a retained subscription when its unchanged binding loses ownership", async () => {
    const sessionFile = path.join(tempDir, "warm-conflict-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-conflict-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm-conflict");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-conflict",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );
    const conflictBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        if (args[1].kind === "patch") {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      }),
    };

    await expect(
      startOrResumeThreadImpl({ ...common, bindingStore: conflictBindingStore }),
    ).rejects.toMatchObject({ name: "CodexThreadBindingConflictError" });

    expect(conflictBindingStore.mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "patch", threadId: "thread-warm-conflict" }),
      expect.any(Function),
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
    ]);
  });

  it("releases a retained subscription before changing context-engine mode", async () => {
    const sessionFile = path.join(tempDir, "warm-context-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-context-workspace");
    const params = createParams(sessionFile, workspaceDir);
    let startCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        startCount += 1;
        return threadStartResult(`thread-warm-context-${startCount}`);
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-context",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);

    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const rotated = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(rotated).toMatchObject({
      threadId: "thread-warm-context-2",
      contextEngine: { engineId: "lossless-claw" },
      lifecycle: { action: "started", rotatedContextEngineBinding: true },
    });
  });

  it("releases and resumes a retained thread when its effective config changes", async () => {
    const sessionFile = path.join(tempDir, "warm-config-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-config-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-config");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread({
      ...common,
      config: { test_setting: "before" },
    });
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    const resumed = await startOrResumeThread({
      ...common,
      config: { test_setting: "after" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(resumed).toMatchObject({
      threadId: "thread-warm-config",
      lifecycle: { action: "resumed" },
    });
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("releases and resumes a retained thread when its auth profile changes", async () => {
    const sessionFile = path.join(tempDir, "warm-auth-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-auth-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = "openai:before";
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-auth");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    params.authProfileId = "openai:after";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(resumed).toMatchObject({
      authProfileId: "openai:after",
      threadId: "thread-warm-auth",
      lifecycle: { action: "resumed" },
    });
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("releases and resumes a retained thread when its model provider changes", async () => {
    const sessionFile = path.join(tempDir, "warm-provider-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-provider-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-provider");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    params.provider = "custom-provider";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ modelProvider: "custom-provider" }),
      expect.anything(),
    );
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("keeps a retained thread warm when its turn-level approval policy changes", async () => {
    const sessionFile = path.join(tempDir, "warm-policy-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-policy-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm-policy");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-policy",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const appServer = createThreadLifecycleAppServerOptions();
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    appServer.approvalPolicy = "on-request";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(resumed.liveThreadConfigFingerprint).toBe(started.liveThreadConfigFingerprint);
  });

  it("fails closed when a retained mode-transition subscription cannot be released", async () => {
    const sessionFile = path.join(tempDir, "unsafe-warm-session.jsonl");
    const workspaceDir = path.join(tempDir, "unsafe-warm-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-unsafe-warm");
      }
      if (method === "thread/unsubscribe") {
        throw new Error("unsubscribe unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-unsafe-warm",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const abandonClient = vi.fn(async () => undefined);
    const common = {
      client,
      abandonClient,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);

    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    await expect(startOrResumeThread(common)).rejects.toMatchObject({
      name: "CodexAppServerUnsafeSubscriptionError",
      message: "Codex retained thread subscription could not be released: thread-unsafe-warm",
    });

    expect(abandonClient).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
    ]);
  });

  it.each([
    { restricted: false, mcpDrift: false },
    { restricted: true, mcpDrift: false },
    { restricted: true, mcpDrift: true },
  ])(
    "reattests live incognito reuse (restricted: $restricted, MCP drift: $mcpDrift)",
    async ({ restricted, mcpDrift }) => {
      const sessionFile = path.join(tempDir, "incognito-session.jsonl");
      const workspaceDir = path.join(tempDir, "incognito-workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.sessionKey = "agent:main:dashboard:incognito-two-turns";
      if (restricted) {
        params.toolsAllow = ["openclaw"];
      }
      let secondTurn = false;
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "config/read") {
          return { layers: [], config: { mcp_servers: {} } };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "mcpServerStatus/list") {
          return {
            data:
              secondTurn && mcpDrift
                ? [
                    {
                      ...disabledMcpServerStatus("unexpected-server"),
                      serverInfo: { name: "unexpected-server", version: "1.0" },
                      tools: { unexpected_tool: { name: "unexpected_tool", inputSchema: {} } },
                    },
                  ]
                : [],
            nextCursor: null,
          };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-incognito");
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = {
        getInstanceId: () => "client-incognito",
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      const common = {
        client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        ...(restricted ? { nativeCodeModeEnabled: false, hostSystemAgentActive: true } : {}),
      };

      const first = await startOrResumeThread(common);
      await retainCodexAppServerLiveThread(
        client,
        first.threadId,
        undefined,
        first.liveThreadConfigFingerprint,
        null,
        first.liveThreadEphemeralPolicy,
      );
      const before = await readCodexAppServerBinding(sessionFile);
      secondTurn = true;
      if (mcpDrift) {
        await expect(startOrResumeThread(common)).rejects.toThrow(
          "Codex restricted-tool-surface MCP attestation found unexpected server unexpected-server",
        );
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
        expect(
          request.mock.calls
            .filter(([method]) => method.startsWith("thread/"))
            .map(([method, requestParams]) => [method, requestParams]),
        ).toEqual([
          ["thread/start", expect.objectContaining({ ephemeral: true })],
          ["thread/unsubscribe", { threadId: first.threadId }],
        ]);
        return;
      }
      const second = await startOrResumeThread(common);

      expect(first).toMatchObject({
        clientId: "client-incognito",
        threadId: "thread-incognito",
        lifecycle: { action: "started" },
      });
      expect(second).toMatchObject({
        clientId: "client-incognito",
        threadId: "thread-incognito",
        lifecycle: { action: "resumed" },
      });
      const threadCalls = request.mock.calls.filter(([method]) => method.startsWith("thread/"));
      expect(threadCalls.map(([method]) => method)).toEqual(["thread/start"]);
      expect(threadCalls[0]?.[1]).toEqual(expect.objectContaining({ ephemeral: true }));
    },
  );

  it("resumes the same restricted OpenClaw thread so turn two retains native memory", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-normal",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    let nextThread = 1;
    const respond = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          layers: [
            {
              name: {
                type: "packagedDefaults",
                file: "/managed/codex/defaults.toml",
              },
            },
          ],
          config: {
            mcp_servers: {
              "arbitrary.server": { command: "ignored" },
              "local helper": { url: "https://mcp.example.test" },
            },
          },
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-ring-zero-${nextThread++}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-ring-zero-1");
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            disabledMcpServerStatus("arbitrary.server"),
            disabledMcpServerStatus("local helper"),
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("openclaw")],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    const first = await startOrResumeThread(common);
    await fixture.endTurn("thread-ring-zero-1");
    const second = await startOrResumeThread(common);

    expect(first.lifecycle.action).toBe("started");
    expect(second.lifecycle.action).toBe("resumed");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "mcpServerStatus/list",
      "thread/inject_items",
    ]);
    const startCalls = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(startCalls.map(([, startParams]) => startParams)).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          mcp_servers: {
            "arbitrary.server": { enabled: false },
            "local helper": { enabled: false },
          },
        }),
      }),
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-ring-zero-1");
    expect(binding?.ringZeroConfigFingerprint).toEqual(expect.any(String));
    expect(binding?.ringZeroClientInstanceId).toEqual(expect.any(String));
  });

  it("isolates transient message-only completion threads without replacing the parent binding", async () => {
    const sessionFile = path.join(tempDir, "message-only-session.jsonl");
    const workspaceDir = path.join(tempDir, "message-only-workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-parent",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["message"];
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.delegationCapability = "report_only";
    params.inputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:child",
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    };
    let nextThread = 1;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          layers: [],
          config: {
            mcp_servers: {
              "arbitrary.server": { command: "inherited-mcp" },
              "local helper": { url: "https://mcp.example.test" },
            },
          },
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-message-only-${nextThread++}`);
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            disabledMcpServerStatus("arbitrary.server"),
            disabledMcpServerStatus("local helper"),
            disabledMcpServerStatus("request-only"),
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const messageTool = createMessageDynamicTool("Send the source conversation reply");
    const common = {
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [messageTool],
      config: {
        "features.apps": true,
        "features.chronicle": true,
        "features.current_time_reminder": true,
        "features.deferred_executor": true,
        "features.hooks": true,
        "features.image_generation": true,
        "features.multi_agent": true,
        "features.multi_agent_v2": true,
        "features.plugins": true,
        "features.skill_search": true,
        "features.shell_tool": true,
        "features.standalone_web_search": true,
        "features.token_budget": true,
        "features.unified_exec": true,
        "features.view_image": true,
        "orchestrator.mcp.enabled": true,
        "tools.experimental_request_user_input.enabled": true,
        "tools.update_plan.enabled": true,
        mcp_servers: {
          "request-only": { command: "request-mcp" },
        },
        web_search: "live",
      },
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: false,
    };

    const first = await startOrResumeThread(common);
    const second = await startOrResumeThread(common);

    expect(first.lifecycle.action).toBe("started");
    expect(second.lifecycle.action).toBe("started");
    expect(first.threadId).toBe("thread-message-only-1");
    expect(second.threadId).toBe("thread-message-only-2");
    expect(first).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(second).not.toHaveProperty("liveThreadConfigFingerprint");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-parent");
    const threadRequests = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(threadRequests).toHaveLength(2);
    const resumeRequest = buildThreadResumeParams(params, {
      threadId: first.threadId,
      appServer: common.appServer,
      dynamicTools: common.dynamicTools,
      config: common.config,
      nativeCodeModeEnabled: false,
      hostSystemAgentActive: false,
      restrictedToolSurfaceInheritedMcpServerNames: ["arbitrary.server", "local helper"],
    });
    const threadPayloads = [
      ...threadRequests.map(([, threadRequest]) => threadRequest),
      resumeRequest,
    ];
    for (const threadRequest of threadPayloads) {
      expect(threadRequest).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            mcp_servers: {
              "arbitrary.server": { enabled: false },
              "local helper": { enabled: false },
              "request-only": { command: "request-mcp", enabled: false },
            },
            web_search: "disabled",
          }),
          developerInstructions: expect.stringContaining("`message(action=send)`"),
        }),
      );
      const typedThreadRequest = threadRequest as {
        config?: Record<string, unknown>;
        developerInstructions?: string;
      };
      const threadConfig = typedThreadRequest.config;
      for (const disabledFeature of [
        "features.apps",
        "features.current_time_reminder",
        "features.deferred_executor",
        "features.hooks",
        "features.image_generation",
        "features.multi_agent",
        "features.multi_agent_v2",
        "features.plugins",
        "features.standalone_web_search",
        "features.token_budget",
        "orchestrator.mcp.enabled",
        "tools.experimental_request_user_input.enabled",
        "tools.update_plan.enabled",
      ]) {
        expect(threadConfig?.[disabledFeature]).toBe(false);
      }
      expect(typedThreadRequest.developerInstructions).not.toContain("`spawn_agent`");
      expect(typedThreadRequest.developerInstructions).not.toContain("`tool_search`");
    }
    for (const [, startRequest] of threadRequests) {
      expect(startRequest).toEqual(
        expect.objectContaining({ dynamicTools: [messageTool], environments: [] }),
      );
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
    ]);
    for (const threadId of ["thread-message-only-1", "thread-message-only-2"]) {
      expect(request).toHaveBeenCalledWith(
        "mcpServerStatus/list",
        { threadId, detail: "toolsAndAuthOnly" },
        expect.anything(),
      );
    }
  });

  it("removes every native capability from an explicitly restricted thread", () => {
    const params = createParams(
      path.join(tempDir, "conversation-policy-session.jsonl"),
      path.join(tempDir, "conversation-policy-workspace"),
    );
    params.conversationToolPolicy = { deny: ["exec"] };
    params.pluginHarnessToolPolicyRestricted = true;
    const request = buildThreadResumeParams(params, {
      threadId: "thread-policy-restricted",
      appServer: createThreadLifecycleAppServerOptions(),
      dynamicTools: [],
      config: {
        "features.apps": true,
        "features.current_time_reminder": true,
        "features.deferred_executor": true,
        "features.hooks": true,
        "features.image_generation": true,
        "features.memories": true,
        "features.multi_agent": true,
        "features.multi_agent_v2": true,
        "features.plugins": true,
        "features.standalone_web_search": true,
        "features.token_budget": true,
        "orchestrator.mcp.enabled": true,
        "orchestrator.skills.enabled": true,
        "tools.experimental_request_user_input.enabled": true,
        "tools.update_plan.enabled": true,
        mcp_servers: { inherited: { command: "unsafe" } },
        web_search: "live",
      },
      nativeCodeModeEnabled: false,
      hostSystemAgentActive: false,
      restrictedToolSurfaceInheritedMcpServerNames: ["inherited"],
    });

    expect(request.config).toMatchObject({
      "features.apps": false,
      "features.artifact": false,
      "features.browser_use": false,
      "features.browser_use_external": false,
      "features.browser_use_full_cdp_access": false,
      "features.chronicle": false,
      "features.computer_use": false,
      "features.current_time_reminder": false,
      "features.default_mode_request_user_input": false,
      "features.deferred_executor": false,
      "features.hooks": false,
      "features.image_generation": false,
      "features.memories": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.plugins": false,
      "features.request_permissions_tool": false,
      "features.skill_search": false,
      "features.shell_tool": false,
      "features.standalone_web_search": false,
      "features.token_budget": false,
      "features.unified_exec": false,
      "features.view_image": false,
      "features.web_search_cached": false,
      "features.web_search_request": false,
      "features.workspace_dependencies": false,
      "orchestrator.mcp.enabled": false,
      "orchestrator.skills.enabled": false,
      "skills.bundled.enabled": false,
      "skills.include_instructions": false,
      "tools.experimental_request_user_input.enabled": false,
      "tools.update_plan.enabled": false,
      mcp_servers: { inherited: { command: "unsafe", enabled: false } },
      web_search: "disabled",
    });
  });

  it("starts a fresh restricted OpenClaw thread for a new app-server client", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    let nextThread = 1;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-ring-zero-${nextThread++}`);
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("openclaw")],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    const first = await startOrResumeThread({ ...common, client: { request } as never });
    const second = await startOrResumeThread({ ...common, client: { request } as never });

    expect(first.lifecycle.action).toBe("started");
    expect(second.lifecycle.action).toBe("started");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("thread/resume");
    const startCalls = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(startCalls).toHaveLength(2);
    expect(startCalls.map(([, startParams]) => startParams)).toEqual([
      expect.objectContaining({ environments: [] }),
      expect.objectContaining({ environments: [] }),
    ]);
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-ring-zero-2");
  });

  it.each([
    { cleanup: "confirmed", cleanupFails: false, revokeHost: false },
    { cleanup: "unconfirmed", cleanupFails: true, revokeHost: false },
    { cleanup: "host revoked", cleanupFails: false, revokeHost: true },
  ])(
    "cleans the resumed subscription after MCP attestation failure, cleanup=$cleanup",
    async ({ cleanupFails, revokeHost }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const cleanupEntered = createDeferred<void>();
      const cleanupProceed = createDeferred<void>();
      let attestationCount = 0;
      let rejectUnsubscribe = false;
      let pauseCleanup = false;
      const respond = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult("thread-ring-zero");
        }
        if (method === "mcpServerStatus/list") {
          attestationCount += 1;
          return attestationCount === 1
            ? { data: [], nextCursor: null }
            : { data: [{ name: "late-server" }], nextCursor: null };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
        unsubscribe: async () => {
          if (pauseCleanup) {
            cleanupEntered.resolve();
            await cleanupProceed.promise;
          }
          if (rejectUnsubscribe) {
            throw new Error("unsubscribe unavailable");
          }
          return { status: "unsubscribed" };
        },
      });
      const { client, request } = fixture;
      const abandonClient = vi.fn(async () => {});
      const common = {
        client,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      };

      await startOrResumeThread(common);
      await fixture.endTurn("thread-ring-zero");
      const before = await readCodexAppServerBinding(sessionFile);
      rejectUnsubscribe = cleanupFails;
      pauseCleanup = revokeHost;
      const pending = startOrResumeThread(common).catch((cause: unknown) => cause);
      if (revokeHost) {
        await cleanupEntered.promise;
        closeHost();
        cleanupProceed.resolve();
      }
      const error = await pending;
      expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
      expect(error).toMatchObject({
        name: "CodexThreadPolicyHandoffError",
        outcome: "not-written",
        cause: expect.objectContaining({
          message: "Codex mcpServerStatus/list returned an invalid restricted-tool-surface server",
        }),
      });

      expect(abandonClient).toHaveBeenCalledTimes(cleanupFails || revokeHost ? 1 : 0);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/start",
        "mcpServerStatus/list",
        "thread/unsubscribe",
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/resume",
        "mcpServerStatus/list",
        "thread/unsubscribe",
      ]);
      expect(
        request.mock.calls.some(
          ([method]) => method === "turn/start" || method === "thread/delete",
        ),
      ).toBe(false);
    },
  );

  it("fails closed before starting OpenClaw when inherited MCP enumeration fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-normal",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        throw new Error("config unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow("config unavailable");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-normal");
  });

  it.each([
    {
      expectedError:
        'Codex restricted tool surface cannot override config layer legacyManagedConfigTomlFromFile; migrate /etc/codex/managed_config.toml to /etc/codex/requirements.toml before running restricted or isolated turns. For ChatGPT-only authentication, use allowed_login_methods = ["chatgpt"] in /etc/codex/requirements.toml.',
      name: "legacy managed file",
      layer: {
        name: {
          file: "/etc/codex/managed_config.toml",
          type: "legacyManagedConfigTomlFromFile",
        },
      },
    },
    {
      expectedError:
        'Codex restricted tool surface cannot override config layer legacyManagedConfigTomlFromMdm; replace the legacy MDM payload with base64-encoded TOML requirements in the com.openai.codex managed preference requirements_toml_base64 before running restricted or isolated turns. For ChatGPT-only authentication, include allowed_login_methods = ["chatgpt"] in that TOML payload.',
      name: "legacy managed MDM",
      layer: { name: { type: "legacyManagedConfigTomlFromMdm" } },
    },
    {
      expectedError: /config layer/u,
      name: "unknown future",
      layer: { name: { type: "futureManaged" } },
    },
    { expectedError: /config layers/u, name: "malformed", layer: { name: {} } },
  ])(
    "fails closed on $name config layers before OpenClaw thread/start",
    async ({ expectedError, layer }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [layer] };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params,
          cwd: workspaceDir,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          appServer: createThreadLifecycleAppServerOptions(),
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow(expectedError);
      expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
    },
  );

  it.each(["hooks", "managed_hooks"] as const)(
    "fails closed on non-empty %s requirements before OpenClaw thread/start",
    async (requirementsKey) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return {
            requirements: {
              [requirementsKey]: {
                PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }],
              },
            },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params,
          cwd: workspaceDir,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          appServer: createThreadLifecycleAppServerOptions(),
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow("cannot override managed hooks");
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
      ]);
    },
  );

  it("admits configured managed hooks for an interactive plugin-policy turn", async () => {
    const sessionFile = path.join(tempDir, "plugin-policy-session.jsonl");
    const workspaceDir = path.join(tempDir, "plugin-policy-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.pluginHarnessToolPolicyRestricted = true;
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return {
          requirements: {
            hooks: {
              PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }],
            },
            featureRequirements: { hooks: true },
          },
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-plugin-policy-managed-hooks");
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });

    await expect(
      startOrResumeThread({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: false,
      }),
    ).resolves.toMatchObject({
      threadId: "thread-plugin-policy-managed-hooks",
      lifecycle: { action: "started" },
    });
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
    ]);
  });

  it("fails closed when requirements pin a restricted Codex feature on", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { hooks: true } } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow("cannot override required feature hooks");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
    ]);
  });

  it("fails closed when requirements pin denied image generation on", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { image_generation: true } } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
      }),
    ).rejects.toThrow("cannot override required feature image_generation");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["configRequirements/read"]);
  });

  it.each([
    "apps",
    "artifact",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "chronicle",
    "code_mode",
    "code_mode_only",
    "computer_use",
    "current_time_reminder",
    "default_mode_request_user_input",
    "deferred_executor",
    "goals",
    "hooks",
    "image_generation",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "plugins",
    "request_permissions_tool",
    "skill_search",
    "shell_tool",
    "standalone_web_search",
    "token_budget",
    "unified_exec",
    "view_image",
    "web_search_cached",
    "web_search_request",
    "workspace_dependencies",
    "codex_hooks",
  ])("fails closed when requirements pin native registry %s on", async (feature) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { [feature]: true } } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow(`cannot override required feature ${feature}`);
  });

  it.each(
    [
      {
        name: "a newly raced server",
        attestation: { data: [{ name: "raced" }] },
        failure: "returned an invalid restricted-tool-surface server",
      },
      {
        name: "a malformed inventory",
        attestation: { data: "invalid" },
        failure: "returned an invalid restricted-tool-surface attestation",
      },
      {
        name: "an inventory RPC failure",
        attestation: new Error("inventory failed"),
        failure: "inventory failed",
      },
    ].flatMap((scenario) => [
      { ...scenario, ephemeral: false },
      { ...scenario, ephemeral: true },
    ]),
  )(
    "discards the fresh thread after MCP attestation finds $name, ephemeral=$ephemeral",
    async ({ attestation, failure, ephemeral }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-normal",
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        dynamicToolsFingerprint: "[]",
      });
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      if (ephemeral) {
        params.sessionKey = "agent:main:internal-session-effects:incognito-mcp-attestation";
      }
      const abandonClient = vi.fn(async () => {});
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-ring-zero");
        }
        if (method === "thread/delete") {
          return {};
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        if (method === "mcpServerStatus/list") {
          if (attestation instanceof Error) {
            throw attestation;
          }
          return attestation;
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params,
          cwd: workspaceDir,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          appServer: createThreadLifecycleAppServerOptions(),
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow(failure);
      expect(abandonClient).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/start",
        "mcpServerStatus/list",
        ephemeral ? "thread/unsubscribe" : "thread/delete",
      ]);
      expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
      expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    },
  );

  it.each(["thread-start", "binding-commit"])(
    "discards a fresh thread when abort arrives during %s",
    async (phase) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      const appServer = createThreadLifecycleAppServerOptions();
      const abortController = new AbortController();
      if (phase === "binding-commit") {
        const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
        vi.spyOn(testCodexAppServerBindingStore, "mutate").mockImplementation(async (...args) => {
          if (args[1].kind === "set") {
            abortController.abort("test_abort");
          }
          return await mutate(...args);
        });
      }
      let resolveStart: ((value: ReturnType<typeof threadStartResult>) => void) | undefined;
      const request = vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/start") {
          return await new Promise<ReturnType<typeof threadStartResult>>((resolve) => {
            resolveStart = resolve;
          });
        }
        if (method === "thread/delete") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const run = startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer,
        signal: abortController.signal,
      });
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("thread/start", expect.any(Object), {
          signal: abortController.signal,
        }),
      );
      if (phase === "thread-start") {
        abortController.abort("test_abort");
      }
      resolveStart?.(threadStartResult("thread-after-abort"));

      await expect(run).rejects.toThrow("test_abort");
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
        "thread/delete",
      ]);
    },
  );

  it("starts a fresh Codex thread when dynamic tool descriptions change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult(
          request.mock.calls.length === 1 ? "thread-existing" : "thread-refreshed",
        );
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send and manage messages for the current Slack thread."),
      ],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send and manage messages for the current Discord channel."),
      ],
      appServer,
    });

    expect(binding.threadId).toBe("thread-refreshed");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      dynamicTools: [
        {
          name: "message",
          description: "Send and manage messages for the current Discord channel.",
        },
      ],
    });
  });

  it.each([
    ["gpt-5.6-luna", "gpt-5.6-sol"],
    ["gpt-5.6-luna", "gpt-5.6-terra"],
    ["gpt-5.6-sol", "gpt-5.6-luna"],
    ["gpt-5.6-terra", "gpt-5.6-luna"],
  ])("starts a fresh thread when switching from %s to %s", async (bindingModel, requestedModel) => {
    const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: bindingModel,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.modelId = requestedModel;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        const response = threadStartResult("thread-rebound");
        response.model = (requestParams as { model: string }).model;
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ model: requestedModel });
    expect(binding).toMatchObject({
      threadId: "thread-rebound",
      model: requestedModel,
      lifecycle: { action: "started" },
    });
  });

  it.each([
    ["gpt-5.6-sol", "gpt-5.6-terra"],
    ["gpt-5.6-terra", "gpt-5.6-sol"],
  ])("resumes the thread when switching from %s to %s", async (bindingModel, requestedModel) => {
    const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: bindingModel,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.modelId = requestedModel;
    const respond = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/resume") {
        const response = threadStartResult("thread-existing");
        response.model = (requestParams as { model: string }).model;
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    const binding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
      threadId: "thread-existing",
      model: requestedModel,
    });
    expect(binding).toMatchObject({
      threadId: "thread-existing",
      model: requestedModel,
      lifecycle: { action: "resumed" },
    });
  });

  it("sends canonical typed dynamic tools on thread start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-typed-tools");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send a message."),
        createDeferredNamedDynamicTool("web_search"),
      ],
      appServer,
    });

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as
      | { dynamicTools?: unknown[] }
      | undefined;
    expect(startParams?.dynamicTools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "message",
        description: "Send a message.",
      }),
      expect.objectContaining({
        type: "namespace",
        name: "openclaw",
        tools: [
          expect.objectContaining({
            type: "function",
            name: "web_search",
            deferLoading: true,
          }),
        ],
      }),
    ]);
  });

  it("keeps the bound local provider when recoverable resume failure starts a fresh thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "local-model-2";
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/resume") {
        throw new CodexAppServerRpcError({ code: -32_000, message: "stale thread" }, method);
      }
      if (method === "thread/start") {
        const response = threadStartResult("thread-new");
        response.model = "local-model-2";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    const binding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(startParams?.model).toBe("local-model-2");
    expect(startParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-new");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("fails closed when a structured resume failure cannot release its subscription", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        throw new CodexAppServerRpcError({ code: -32_603, message: "resume failed" }, method);
      }
      if (method === "thread/start") {
        throw new Error("unsafe resume must not start a replacement thread");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
      unsubscribe: async () => {
        throw new Error("unsubscribe rejected");
      },
    });
    const { client, request } = fixture;

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toMatchObject({ name: "CodexAppServerUnsafeSubscriptionError" });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
    ]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
    });
  });

  it("retires an ownership-lost resume client while preserving its binding and draining siblings", async () => {
    const sessionFile = path.join(tempDir, "ownership-lost-session.jsonl");
    const workspaceDir = path.join(tempDir, "ownership-lost-workspace");
    const agentDir = path.join(tempDir, "agent");
    const threadId = "thread-ownership-lost";
    const rolloutPath = path.join(agentDir, "codex-home", "sessions", `rollout-${threadId}.jsonl`);
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: threadId, dynamic_tools: [] } })}\n`,
    );
    const response = threadStartResult(threadId, { cwd: workspaceDir });
    let releaseSibling: (() => void) | undefined;
    const wire = await createLeasedLifecycleWireClient(agentDir, (request) => {
      if (request.method === "thread/read") {
        return { thread: { ...response.thread, path: rolloutPath, status: { type: "notLoaded" } } };
      }
      if (request.method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      if (request.method === "thread/resume") {
        // Retirement revokes this preparation, while an unrelated live lease drains.
        releaseSibling = retainSharedCodexAppServerClientIfCurrent(wire.client);
        retireSharedCodexAppServerClientIfCurrent(wire.client);
        return response;
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId,
        clientId: wire.client.getInstanceId(),
        cwd: workspaceDir,
        model: response.model,
        modelProvider: "openai",
        dynamicToolsFingerprint: "[]",
        pendingResumeConfiguration: true,
      });
      const originalBinding = await readCodexAppServerBinding(sessionFile);
      await expect(wire.start(sessionFile, workspaceDir)).rejects.toMatchObject({
        name: "CodexThreadPolicyHandoffError",
        outcome: "not-written",
      });

      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(originalBinding);
      expect(wire.writes.map((message) => (JSON.parse(message) as RpcRequest).method)).toEqual([
        "thread/read",
        "thread/unsubscribe",
        "thread/resume",
      ]);
      expect(releaseSibling).toBeTypeOf("function");
      const retained = retainSharedCodexAppServerClientIfCurrent(wire.client);
      retained?.();
      expect(retained).toBeUndefined();
      expect(releaseLeasedSharedCodexAppServerClient(wire.client)).toBe(true);
      expect(wire.stdinDestroyed).toBe(false);
      await expect(
        wire.client.request("thread/read", { threadId, includeTurns: false }),
      ).resolves.toMatchObject({
        thread: { id: threadId },
      });
      releaseSibling?.();
      expect(wire.stdinDestroyed).toBe(true);
    } finally {
      releaseSibling?.();
      releaseLeasedSharedCodexAppServerClient(wire.client);
      wire.client.close();
    }
  });

  it("preserves the bound thread and shared client after an exact overload rejection", async () => {
    const sessionFile = path.join(tempDir, "overloaded-session.jsonl");
    const workspaceDir = path.join(tempDir, "overloaded-workspace");
    const agentDir = path.join(tempDir, "agent");
    const overload = new CodexAppServerRpcError(
      { code: -32_001, message: "queue full" },
      "thread/resume",
    );
    const wire = await createLeasedLifecycleWireClient(agentDir, (request) => {
      if (request.method === "thread/read") {
        return {
          thread: {
            ...threadStartResult("thread-overloaded").thread,
            status: { type: "notLoaded" },
          },
        };
      }
      if (request.method === "thread/resume") {
        throw overload;
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-overloaded",
        clientId: wire.client.getInstanceId(),
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        dynamicToolsFingerprint: "[]",
      });
      const originalBinding = await readCodexAppServerBinding(sessionFile);
      await expect(wire.start(sessionFile, workspaceDir)).rejects.toMatchObject({
        name: "CodexAppServerRpcError",
        code: -32_001,
        message: overload.message,
      });

      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(originalBinding);
      expect(
        new Set(wire.writes.map((message) => (JSON.parse(message) as RpcRequest).method)),
      ).toEqual(new Set(["thread/read", "thread/resume"]));
      const retained = retainSharedCodexAppServerClientIfCurrent(wire.client);
      expect(retained).toBeTypeOf("function");
      retained?.();
      expect(wire.stdinDestroyed).toBe(false);
    } finally {
      releaseLeasedSharedCodexAppServerClient(wire.client);
      wire.client.close();
    }
  });

  it("keeps the bound local provider when stale fingerprints force a fresh thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "local-model",
      modelProvider: "lmstudio",
      dynamicToolsFingerprint: "stale-fingerprint",
      dynamicToolsContainDeferred: false,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "local-model-2";
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        const response = threadStartResult("thread-new");
        response.model = "local-model-2";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("web_search")],
      appServer,
    });

    const startParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(startParams?.model).toBe("local-model-2");
    expect(startParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-new");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("keeps the bound local provider when the bound model id contains a slash", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      dynamicToolsFingerprint: "[]",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "openai/gpt-oss-20b";
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/resume") {
        const response = threadStartResult("thread-existing");
        response.model = "openai/gpt-oss-20b";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    const binding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    const resumeParams = request.mock.calls.find(([method]) => method === "thread/resume")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(resumeParams?.model).toBe("openai/gpt-oss-20b");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-existing");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("starts a fresh Codex thread when web search switches to a managed provider", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        // Resume must echo the requested thread; anything else is rejected as
        // an unsafe subscription.
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });
    params.config = {
      tools: {
        web: {
          search: { provider: "brave" },
        },
      },
    };
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("uses a transient Codex thread when runtime toolsAllow denies web_search", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const respond = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-1");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
      appServer,
    });
    params.toolsAllow = ["message"];
    await fixture.endTurn("thread-1");
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: false,
      appServer,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.toolsAllow = undefined;
    await fixture.endTurn("thread-2");
    const resumedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(
      request.mock.calls.filter(
        ([method]) => method === "thread/start" || method === "thread/resume",
      )[1]?.[1],
    ).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("keeps the retained primary subscribed across a transient report-only turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-report-only",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });

    const started = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );
    params.delegationCapability = "report_only";
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.delegationCapability = "full";
    const resumedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: {
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      },
    });
  });

  it("preserves the native-search binding when provider capability support is unknown", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const respond = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "supported",
      webSearchAllowed: true,
      appServer,
    });
    await fixture.endTurn("thread-1");
    const transientBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "unknown",
      webSearchAllowed: true,
      appServer,
    });
    const savedAfterUnknownSupport = await readCodexAppServerBinding(sessionFile);
    await fixture.endTurn("thread-2");
    const resumedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "supported",
      webSearchAllowed: true,
      appServer,
    });

    expect(transientBinding.threadId).toBe("thread-2");
    expect(transientBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterUnknownSupport?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(
      request.mock.calls.filter(
        ([method]) => method === "thread/start" || method === "thread/resume",
      )[1]?.[1],
    ).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("does not persist a first-turn managed fallback when provider capability support is unknown", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "unknown",
      webSearchAllowed: true,
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-transient");
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("persists a restricted Codex thread when effective config policy denies web_search", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const respond = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
      appServer,
    });
    params.config = { tools: { deny: ["web_search"] } };
    params.toolsAllow = [];
    await fixture.endTurn("thread-1");
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });
    await fixture.endTurn("thread-2");
    const resumedRestrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(resumedRestrictedBinding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("persists config-denied search when runtime toolsAllow also excludes web_search", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const respond = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      persistentWebSearchAllowed: true,
      webSearchAllowed: true,
      appServer,
    });
    params.config = { tools: { deny: ["web_search"] } };
    params.toolsAllow = ["message"];
    await fixture.endTurn("thread-1");
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });
    await fixture.endTurn("thread-2");
    const resumedRestrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(resumedRestrictedBinding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("replaces the Codex binding when web search is persistently disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });
    params.config = {
      tools: {
        web: {
          search: { enabled: false },
        },
      },
    };
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      webSearchAllowed: false,
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
  });

  it("starts a fresh Codex thread for default hosted search on a legacy binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: {
        "features.standalone_web_search": false,
        web_search: "cached",
      },
    });
  });

  it("starts a fresh Codex thread for a restrictive web search policy on a legacy binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.config = {
      tools: {
        web: {
          search: { openaiCodex: { enabled: false } },
        },
      },
    };
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("starts a fresh Codex thread for hosted search restrictions on a legacy binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.config = {
      tools: {
        web: {
          search: { openaiCodex: { allowedDomains: ["example.com"] } },
        },
      },
    };
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: {
        web_search: "cached",
        "tools.web_search.allowed_domains": ["example.com"],
      },
    });
  });

  it("starts a fresh Codex thread when an existing session enters tool-disabled mode", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const respond = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        // Resume must echo the requested thread; anything else is rejected as
        // an unsafe subscription.
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    params.disableTools = true;
    await fixture.endTurn("thread-1");
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.disableTools = false;
    await fixture.endTurn("thread-2");
    const resumedBinding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(
      request.mock.calls.filter(
        ([method]) => method === "thread/start" || method === "thread/resume",
      )[1]?.[1],
    ).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("starts a fresh Codex thread when dynamic tools switch from deferred to direct", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("web_search")],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
  });

  it("resumes a bound Codex thread when dynamic tools are reordered", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("wiki_status"), createNamedDynamicTool("diffs")],
      appServer,
    });
    await fixture.endTurn("thread-existing");
    const binding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("diffs"), createNamedDynamicTool("wiki_status")],
      appServer,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("starts a fresh Codex thread for legacy context-engine sidecars without metadata", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine?.engineId).toBe("lossless-claw");
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain('"contextTokenBudget":400000');
  });

  it("resumes a Codex thread when context-engine sidecar metadata is compatible", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const contextEngine = {
      schemaVersion: 1 as const,
      engineId: "lossless-claw",
      policyFingerprint:
        '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
    };
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    const binding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(binding.lifecycle).toEqual({ action: "resumed" });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("starts a fresh Codex thread when context-engine sidecar metadata is no longer active", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine).toBeUndefined();
  });

  it("starts a fresh Codex thread when context-engine policy metadata changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","engineVersion":"1.0.0","ownsCompaction":true,"turnMaintenanceMode":"foreground","citationsMode":"inline","contextTokenBudget":400000,"projectionMaxChars":1000000}',
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: {
        id: "lossless-claw",
        name: "Lossless Claw",
        version: "1.0.1",
        ownsCompaction: true,
        turnMaintenanceMode: "foreground",
      },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.config = { memory: { citations: "inline" } } as never;
    params.contextTokenBudget = 400_000;
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain('"engineVersion":"1.0.1"');
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain(
      '"turnMaintenanceMode":"foreground"',
    );
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain('"citationsMode":"inline"');
  });

  it("keeps the previous dynamic tool fingerprint for transient no-tool maintenance turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let nextThread = 1;
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-${nextThread++}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-1");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("message")],
      appServer,
    });
    const fingerprint = (await readCodexAppServerBinding(sessionFile))?.dynamicToolsFingerprint;
    await fixture.endTurn("thread-1");
    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    await fixture.endTurn("thread-2");
    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("message")],
      appServer,
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.dynamicToolsFingerprint).toBe(fingerprint);
    expect(binding?.dynamicToolsContainDeferred).toBe(true);
    expect(binding?.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("stores large dynamic tool fingerprints as bounded hashes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-large-tools");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const largeDynamicTools = [
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: Array.from({ length: 200 }, (_, index) => ({
          ...createNamedDynamicTool(`tool_${index}`),
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 20 }, (__, propertyIndex) => [
                `property_${propertyIndex}`,
                {
                  type: "string",
                  description: "x".repeat(200),
                },
              ]),
            ),
            additionalProperties: false,
          },
        })),
      },
    ] satisfies Parameters<typeof startOrResumeThread>[0]["dynamicTools"];

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: largeDynamicTools,
      appServer: createThreadLifecycleAppServerOptions(),
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.dynamicToolsFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(binding?.dynamicToolsFingerprint).toHaveLength(71);
    expect(binding?.dynamicToolsFingerprint).not.toContain("tool_199");
  });

  it("keeps the native binding isolated from a restricted replacement-tool turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      pluginAppsFingerprint: "plugin-apps-config-1",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;
    const buildDenyAllPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      fingerprint: "plugin-apps-deny-all",
      inputFingerprint: "plugin-apps-input-deny-all",
      policyContext: { fingerprint: "plugin-policy-deny-all", apps: {}, pluginAppIds: {} },
      diagnostics: [],
    }));
    const buildEnabledPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("read"), createNamedDynamicTool("apply_patch")],
      appServer,
      nativeCodeModeEnabled: false,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-deny-all",
        enabledPluginConfigKeys: [],
        build: buildDenyAllPluginThreadConfig,
      },
    });
    const savedAfterDeny = await readCodexAppServerBinding(sessionFile);

    expect(savedAfterDeny?.threadId).toBe("thread-existing");
    expect(savedAfterDeny?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(savedAfterDeny?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");

    await fixture.endTurn("thread-transient");
    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildEnabledPluginThreadConfig,
      },
    });

    expect(buildDenyAllPluginThreadConfig).toHaveBeenCalledTimes(1);
    expect(buildEnabledPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(requestCalls[0]?.[1]).toMatchObject({
      dynamicTools: [
        expect.objectContaining({ name: "read" }),
        expect.objectContaining({ name: "apply_patch" }),
      ],
      environments: [],
    });
    expect((requestCalls[0]?.[1] as { config?: unknown })?.config).toMatchObject({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    const savedAfterAllowed = await readCodexAppServerBinding(sessionFile);
    expect(savedAfterAllowed?.threadId).toBe("thread-existing");
    expect(savedAfterAllowed?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(savedAfterAllowed?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(savedAfterAllowed?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("preserves the binding when the app-server closes during thread resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        fixture.client.close();
        return await new Promise(() => {});
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer,
      }),
    ).rejects.toThrow("codex app-server client is closed");

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/resume"]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });

  it("starts a new thread when the network proxy config is not active on the binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const appServer = createNetworkProxyThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-network-proxy");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1]).not.toHaveProperty("sandbox");
    expect(requestCalls[0]?.[1].config).toMatchObject(appServer.networkProxy.configPatch);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-network-proxy");
    expect(binding?.networkProxyProfileName).toBe("openclaw-network");
    expect(binding?.networkProxyConfigFingerprint).toBe(appServer.networkProxy.configFingerprint);
  });

  it("passes native hook relay config on thread start and resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const config = {
      "features.hooks": true,
      "hooks.PreToolUse": [],
    };
    const expectedConfig = {
      ...config,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
    };

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config,
    });
    await fixture.endTurn("thread-existing");
    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config,
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(requestCalls[0]?.[1].config).toEqual(expectedConfig);
    expect(requestCalls.find(([method]) => method === "thread/resume")?.[1].config).toEqual(
      expectedConfig,
    );
  });

  it("merges native hook relay config with plugin app config when starting a thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": true, hooks: { PreToolUse: [] } },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      hooks: { PreToolUse: [] },
      ...createPluginAppConfigPatch(),
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-plugins");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("keeps native hook relay config as the final thread config patch", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-hooks");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    const finalConfigPatch = {
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [{ type: "command", command: "openclaw-native-hook-relay", timeout: 5 }],
        },
      ],
    };
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        "features.hooks": false,
        "hooks.PreToolUse": [],
        ...createPluginAppConfigPatch(),
      },
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));
    const pluginThreadConfig = {
      enabled: true,
      inputFingerprint: "plugin-apps-input-1",
      build: buildPluginThreadConfig,
    };

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": false },
      finalConfigPatch,
      pluginThreadConfig,
    });
    await fixture.endTurn("thread-hooks");
    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": false },
      finalConfigPatch,
      pluginThreadConfig: {
        ...pluginThreadConfig,
        enabledPluginConfigKeys: ["google-calendar"],
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(requestCalls[0]?.[1].config).toMatchObject({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      "hooks.PreToolUse": finalConfigPatch["hooks.PreToolUse"],
      ...createPluginAppConfigPatch(),
    });
    expect(requestCalls.find(([method]) => method === "thread/resume")?.[1].config).toMatchObject({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      "hooks.PreToolUse": finalConfigPatch["hooks.PreToolUse"],
    });
  });

  it("replays compatible plugin app bindings on thread resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      approvalsReviewer: "auto_review" as const,
    };
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {} };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const basePolicyContext = createPluginAppPolicyContext();
    const pluginAppPolicyContext = {
      ...basePolicyContext,
      apps: {
        ...basePolicyContext.apps,
        "google-calendar-app": {
          ...basePolicyContext.apps["google-calendar-app"],
          destructiveApprovalMode: "ask" as const,
        },
      },
    };
    const askApprovalConfigPatch = createPluginAppConfigPatch({ approvalsReviewer: "user" });
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: askApprovalConfigPatch,
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: buildPluginThreadConfig,
      },
    });
    await fixture.endTurn("thread-plugins");
    const binding = await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(2);
    const requestCalls = request.mock.calls as unknown as Array<
      [string, { approvalsReviewer?: string; config?: unknown }]
    >;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "config/read",
      "thread/start",
      "thread/unsubscribe",
      "config/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    const threadRequests = requestCalls.filter(
      ([method]) => method === "thread/start" || method === "thread/resume",
    );
    expect(threadRequests.map(([, requestParams]) => requestParams.approvalsReviewer)).toEqual([
      "auto_review",
      "auto_review",
    ]);
    expect(threadRequests[0]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...askApprovalConfigPatch,
    });
    expect(threadRequests[1]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...askApprovalConfigPatch,
    });
  });

  it.each<{
    name: string;
    previousFingerprint: string;
    previousPolicyContext: PluginAppPolicyContext;
    configPatch: JsonObject;
    fingerprint: string;
    policyContext: PluginAppPolicyContext;
    enabledPluginConfigKeys: string[];
  }>([
    {
      name: "full binding revalidation removes an app",
      previousFingerprint: "plugin-apps-config-1",
      previousPolicyContext: createPluginAppPolicyContext(),
      configPatch: {
        apps: {
          _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
        },
      },
      fingerprint: "plugin-apps-empty",
      policyContext: { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} },
      enabledPluginConfigKeys: ["google-calendar"],
    },
    {
      name: "app inventory recovers for an empty binding",
      previousFingerprint: "plugin-apps-empty",
      previousPolicyContext: { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} },
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      policyContext: createPluginAppPolicyContext(),
      enabledPluginConfigKeys: [],
    },
    {
      name: "another plugin recovers for a partial binding",
      previousFingerprint: "plugin-apps-partial",
      previousPolicyContext: createPluginAppPolicyContext(),
      configPatch: createTwoPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-2",
      policyContext: createTwoPluginAppPolicyContext(),
      enabledPluginConfigKeys: ["google-calendar", "gmail"],
    },
    {
      name: "another app from the same plugin recovers for a partial binding",
      previousFingerprint: "plugin-apps-partial",
      previousPolicyContext: {
        ...createPluginAppPolicyContext(),
        pluginAppIds: {
          "google-calendar": ["google-calendar-app", "google-calendar-secondary-app"],
        },
      },
      configPatch: createTwoCalendarAppConfigPatch(),
      fingerprint: "plugin-apps-config-calendar-2",
      policyContext: createTwoCalendarAppPolicyContext(),
      enabledPluginConfigKeys: ["google-calendar"],
    },
  ])("rotates the loaded plugin app thread when $name", async (scenario) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: scenario.previousFingerprint,
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: scenario.previousPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-recovered");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: scenario.configPatch,
      fingerprint: scenario.fingerprint,
      inputFingerprint: "plugin-apps-input-1",
      policyContext: scenario.policyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: scenario.enabledPluginConfigKeys,
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(request.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        config: { ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG, ...scenario.configPatch },
      }),
    );
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-recovered",
      pluginAppsFingerprint: scenario.fingerprint,
      pluginAppPolicyContext: scenario.policyContext,
    });
  });

  it("keeps the existing plugin app binding when revalidation fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-config-1",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: async () => {
          throw new Error("plugin inventory unavailable");
        },
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(requestCalls.find(([method]) => method === "thread/resume")?.[1].config).toEqual({
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...createPluginAppConfigPatch(),
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("keeps an empty plugin app binding when recovery still produces the same config", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const emptyPolicyContext = { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} };
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-empty",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: emptyPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      fingerprint: "plugin-apps-empty",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: emptyPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(requestCalls.find(([method]) => method === "thread/resume")?.[1].config).toEqual({
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
  });

  it("starts a new configured thread for legacy bindings missing plugin app metadata", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: async () => ({
          enabled: true,
          configPatch: createPluginAppConfigPatch(),
          fingerprint: "plugin-apps-config-1",
          inputFingerprint: "plugin-apps-input-1",
          policyContext: pluginAppPolicyContext,
          diagnostics: [],
        }),
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      ...createPluginAppConfigPatch(),
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-plugins");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("starts a new Codex thread when dynamic tool schemas change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let nextThread = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-${nextThread++}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.", ["send"])],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.", ["send", "read"])],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
  });

  it("preserves the bound auth profile when resume params omit authProfileId", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      authProfileId: "openai:bound",
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = path.join(tempDir, "agent");
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:bound": {
          type: "oauth",
          provider: "openai",
          access: "scoped-access",
          refresh: "scoped-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: params.agentDir,
      persistedThreads: ["thread-existing"],
      respond: async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const binding = await startOrResumeThread({
      client: fixture.client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: {
        start: {
          transport: "stdio",
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        codeModeOnly: false,
        loopDetectionPreToolUseRelay: true,
        requestTimeoutMs: 60_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        connectionClass: "local-loopback",
        remoteAppsSubstrate: "preconfigured",
      },
    });

    expect(binding.authProfileId).toBe("openai:bound");
    expect(binding.modelProvider).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
