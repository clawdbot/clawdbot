import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { expect, onTestFinished, vi } from "vitest";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import { threadStartResult as nativeThreadStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject, type RpcRequest, type CodexServerNotification } from "./protocol.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./shared-client.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

type NativeFixtureThread = {
  response: Record<string, unknown>;
  thread: Record<string, unknown>;
  loaded: boolean;
  subscribed: boolean;
  items: unknown[];
};

/** A synthetic native server, not a client mock: requests still cross the real wire and guards. */
export function createCodexLifecycleHarness(options: {
  respond: (method: string, params?: unknown) => unknown;
  persistedThreads?: string[];
  unsubscribe?: (threadId: string) => unknown;
}) {
  const threads = new Map<string, NativeFixtureThread>();
  const remember = (response: unknown, loaded: boolean, subscribed: boolean) => {
    if (
      !isJsonObject(response) ||
      !isJsonObject(response.thread) ||
      typeof response.thread.id !== "string"
    ) {
      throw new Error("Native lifecycle fixture requires an explicit thread response");
    }
    const entry: NativeFixtureThread = {
      response,
      thread: response.thread,
      loaded,
      subscribed,
      items: [],
    };
    threads.set(response.thread.id, entry);
    return entry;
  };
  for (const threadId of options.persistedThreads ?? []) {
    remember(nativeThreadStartResult(threadId), false, false);
  }
  const dispatch = async (request: RpcRequest) => {
    const params = isJsonObject(request.params) ? request.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const current = threads.get(threadId);
    if (request.method === "initialize") {
      return { userAgent: "codex-cli/0.151.0" };
    }
    if (request.method === "thread/start") {
      const response = await options.respond(request.method, request.params);
      remember(response, true, true);
      return response;
    }
    if (request.method === "thread/read") {
      if (!current) {
        throw new Error(`Unknown synthetic native thread: ${threadId}`);
      }
      return {
        thread: {
          ...current.thread,
          status: current.loaded ? current.thread.status : { type: "notLoaded" },
        },
      };
    }
    if (request.method === "thread/unsubscribe") {
      const response = options.unsubscribe
        ? await options.unsubscribe(threadId)
        : {
            status: !current?.loaded
              ? "notLoaded"
              : current.subscribed
                ? "unsubscribed"
                : "notSubscribed",
          };
      if (current && isJsonObject(response) && response.status === "notLoaded") {
        current.loaded = false;
        current.subscribed = false;
      } else if (
        current &&
        isJsonObject(response) &&
        (response.status === "unsubscribed" || response.status === "notSubscribed")
      ) {
        current.subscribed = false;
      }
      return response;
    }
    if (request.method === "thread/resume") {
      if (!current) {
        throw new Error(`Unseeded synthetic native resume: ${threadId}`);
      }
      // Stock 0.151.0 retains an unsubscribed loaded cache entry. Full resume overrides
      // trigger teardown only when no subscriber can still observe that session.
      if (
        current.loaded &&
        !current.subscribed &&
        isJsonObject(current.thread.status) &&
        current.thread.status.type === "idle" &&
        current.thread.canAcceptDirectInput !== false &&
        (params.config !== undefined ||
          params.developerInstructions !== undefined ||
          params.baseInstructions !== undefined)
      ) {
        current.loaded = false;
        harness.send({
          method: "thread/status/changed",
          params: { threadId, status: { type: "notLoaded" } },
        });
      }
      const response = await options.respond(request.method, request.params);
      if (current.loaded) {
        current.subscribed = true;
        return current.response;
      }
      const resumed = remember(response, true, true);
      resumed.items = current.items;
      return response;
    }
    if (request.method === "thread/inject_items") {
      if (!current?.loaded || !current.subscribed) {
        throw new Error(`Synthetic injection requires a loaded subscription: ${threadId}`);
      }
      current.items.push(...(Array.isArray(params.items) ? params.items : []));
      return {};
    }
    return await options.respond(request.method, request.params);
  };
  const harness = createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as RpcRequest;
      if (request.id === undefined || typeof request.method !== "string") {
        return;
      }
      void dispatch(request).then(
        (result) => send({ id: request.id, result }),
        (error: unknown) =>
          send({
            id: request.id,
            error: {
              code: error instanceof CodexAppServerRpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof CodexAppServerRpcError ? { data: error.data } : {}),
            },
          }),
      );
    },
  });
  return Object.assign(harness, {
    request: vi.spyOn(harness.client, "request"),
    seed: (
      response: unknown,
      state: { loaded: boolean; subscribed: boolean } = { loaded: false, subscribed: false },
    ) => remember(response, state.loaded, state.subscribed),
    notify: (notification: CodexServerNotification) => {
      const params = isJsonObject(notification.params) ? notification.params : {};
      const current =
        typeof params.threadId === "string" ? threads.get(params.threadId) : undefined;
      if (current && notification.method === "turn/completed") {
        current.thread.status = { type: "idle" };
      }
      if (current && notification.method === "thread/closed") {
        current.loaded = false;
        current.subscribed = false;
      }
      harness.send(notification);
    },
    endTurn: (threadId: string) => harness.client.request("thread/unsubscribe", { threadId }),
  });
}

/** Turn notifications and server requests use the same real client as lifecycle handoffs. */
export function createCodexLifecycleTurnHarness(
  params: Parameters<typeof createCodexLifecycleHarness>[0] & {
    agentDir: string;
    wait: { interval: number; timeout: number };
  },
) {
  const wire = createCodexLifecycleHarness(params);
  const { client, request } = wire;
  const requests: Array<{ method: string; params: unknown }> = [];
  const nativeRequest = CodexAppServerClient.prototype.request.bind(client);
  request.mockImplementation((method, requestParams, options) => {
    if (method !== "initialize") {
      requests.push({ method, params: requestParams });
    }
    return nativeRequest(method, requestParams, options);
  });
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(client);
  // Authentication is outside this lifecycle fixture; the caller still observes
  // its requested selection before acquiring this credential-free physical owner.
  const acquire = async (options?: CodexAppServerClientOptions) =>
    await getLeasedSharedCodexAppServerClient({
      ...options,
      startOptions: {
        transport: "stdio",
        command: process.execPath,
        args: ["app-server"],
        headers: {},
      },
      agentDir: params.agentDir,
      authProfileId: null,
      preparedAuth: undefined,
      authRequirement: undefined,
      config: {},
    });
  onTestFinished(async () => {
    await client.closeAndWait();
  });
  const pendingNotifications = new Set<Promise<unknown>>();
  const registerNotification = client.addNotificationHandler.bind(client);
  vi.spyOn(client, "addNotificationHandler").mockImplementation((handler) =>
    registerNotification((notification) => {
      const pending = Promise.resolve(handler(notification));
      pendingNotifications.add(pending);
      void pending.then(
        () => pendingNotifications.delete(pending),
        () => pendingNotifications.delete(pending),
      );
      return pending;
    }),
  );
  const notify = async (notification: CodexServerNotification) => {
    wire.notify(notification);
    await Promise.all(pendingNotifications);
  };
  const waitForMethod = async (method: string, timeoutMs: number = params.wait.timeout) => {
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain(method), {
      interval: 1,
      timeout: timeoutMs,
    });
  };
  const handleServerRequest = async (incoming: {
    id: string | number;
    method: string;
    params?: unknown;
  }) => {
    wire.send(incoming);
    let response: { result?: unknown; error?: unknown } | undefined;
    await vi.waitFor(() => {
      response = wire.writes
        .map((line) => JSON.parse(line))
        .find((entry) => entry.id === incoming.id && !entry.method);
      expect(response).toBeDefined();
    }, params.wait);
    if (response?.error) {
      throw new Error("Synthetic server request rejected", { cause: response.error });
    }
    return response?.result;
  };
  return {
    acquire,
    client,
    request,
    requests,
    waitForMethod,
    notify,
    handleServerRequest,
    waitForServerRequestHandler: async () => handleServerRequest,
    completeTurn: async ({ threadId, turnId }: { threadId: string; turnId: string }) => {
      await notify({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
    },
    close: () => client.close(),
  };
}

export async function createLeasedCodexLifecycleHarness(
  options: Parameters<typeof createCodexLifecycleHarness>[0] & { agentDir: string },
) {
  const harness = createCodexLifecycleHarness(options);
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
  const acquireOptions: CodexAppServerClientOptions = {
    startOptions: {
      transport: "stdio",
      command: process.execPath,
      args: ["app-server"],
      headers: {},
    },
    agentDir: options.agentDir,
    authProfileId: null,
    config: {},
  };
  try {
    await getLeasedSharedCodexAppServerClient(acquireOptions);
  } finally {
    start.mockRestore();
  }
  harness.request.mockClear();
  onTestFinished(async () => {
    releaseLeasedSharedCodexAppServerClient(harness.client);
    await harness.client.closeAndWait();
  });
  return Object.assign(harness, { acquireOptions });
}

type ThreadLifecycleTestHostCapability = {
  capabilities: EmbeddedRunAttemptParams["hostCapabilities"];
  close: () => void;
};

const activeHostCapabilities = new Set<ThreadLifecycleTestHostCapability>();

function createTrackedThreadLifecycleHostCapability(): ThreadLifecycleTestHostCapability {
  let active = true;
  const assertActive = () => {
    if (!active) {
      throw new Error("thread lifecycle test host capability is no longer active");
    }
  };
  const capabilities: EmbeddedRunAttemptParams["hostCapabilities"] = Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive,
    bindToolSurface: (tools) => {
      assertActive();
      return tools.map((tool) => {
        const execute = tool.execute;
        return {
          ...tool,
          execute: async (...args) => {
            assertActive();
            return await execute(...args);
          },
        };
      });
    },
    runBeforeToolCall: async (request) => {
      assertActive();
      return { blocked: false, params: request.params };
    },
    requestApproval: async () => {
      assertActive();
      return undefined;
    },
    waitForApproval: async () => {
      assertActive();
      return undefined;
    },
  });
  return {
    capabilities,
    close: () => {
      active = false;
    },
  };
}

export function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  return startOrResumeThreadImpl({
    signal: new AbortController().signal,
    ...params,
    bindingStore: testCodexAppServerBindingStore,
  });
}

export function threadStartResult(threadId = "thread-1"): Record<string, unknown> {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp",
      projectId: null,
      cliVersion: "0.149.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

export function threadResumeResult(threadId = "thread-existing"): Record<string, unknown> {
  return threadStartResult(threadId);
}

export function createAppServerOptions(): CodexAppServerRuntimeOptions {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  } as unknown as CodexAppServerRuntimeOptions;
}

export function createParams(
  sessionFile: string,
  workspaceDir: string,
  configOverrides?: EmbeddedRunAttemptParams["config"],
): EmbeddedRunAttemptParams {
  const host = createTrackedThreadLifecycleHostCapability();
  activeHostCapabilities.add(host);
  const authStorage = AuthStorage.inMemory();
  return {
    hostCapabilities: host.capabilities,
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: ModelRegistry.inMemory(authStorage),
    config: configOverrides,
  };
}

export function resetThreadLifecycleTestFixtures(): void {
  for (const host of activeHostCapabilities) {
    host.close();
  }
  activeHostCapabilities.clear();
}

export function setCodexTestModelSupportsTools(
  params: EmbeddedRunAttemptParams,
  supportsTools: boolean,
): void {
  params.model = {
    ...params.model,
    compat: { ...params.model.compat, supportsTools },
  } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } };
}

export function createCodexRuntimePlanFixture(): NonNullable<
  EmbeddedRunAttemptParams["runtimePlan"]
> {
  return {
    auth: {},
    observability: {
      resolvedRef: "codex/gpt-5.4-codex",
      provider: "codex",
      modelId: "gpt-5.4-codex",
      harnessId: "codex",
    },
    prompt: {
      resolveSystemPromptContribution: () => undefined,
    },
    tools: {
      normalize: (tools: unknown[]) => tools,
      logDiagnostics: () => undefined,
    },
  } as unknown as NonNullable<EmbeddedRunAttemptParams["runtimePlan"]>;
}
