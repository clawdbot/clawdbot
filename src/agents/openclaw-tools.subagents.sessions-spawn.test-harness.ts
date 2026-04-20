import { vi, type Mock } from "vitest";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

type SessionsSpawnTestConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
type SessionsSpawnHookRunner = SubagentLifecycleHookRunner | null;
type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
type CreateSessionsSpawnTool =
  (typeof import("./tools/sessions-spawn-tool.js"))["createSessionsSpawnTool"];
type SubagentRegistryTesting = (typeof import("./subagent-registry.js"))["__testing"];
type SubagentSpawnTesting = (typeof import("./subagent-spawn.js"))["__testing"];
export type CreateOpenClawToolsOpts = Parameters<CreateSessionsSpawnTool>[0];
export type GatewayRequest = { method?: string; params?: unknown };
export type AgentWaitCall = { runId?: string; timeoutMs?: number };
type SessionsSpawnGatewayMockOptions = {
  includeSessionsList?: boolean;
  includeChatHistory?: boolean;
  chatHistoryText?: string;
  onAgentSubagentSpawn?: (params: unknown) => void;
  onSessionsPatch?: (params: unknown) => void;
  onSessionsDelete?: (params: unknown) => void;
  agentWaitResult?: { status: "ok" | "timeout"; startedAt: number; endedAt: number };
};

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const sessionStore: Record<string, { sessionId: string; updatedAt: number }> = {};
  let nextRunId = 0;
  const defaultConfigOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  } as SessionsSpawnTestConfig;
  let configOverride = defaultConfigOverride;
  const defaultRunSubagentAnnounceFlow: RunSubagentAnnounceFlow = async (params) => {
    const statusLabel =
      params.outcome?.status === "timeout" ? "timed out" : "completed successfully";
    const requesterSessionKey = resolveRequesterStoreKey(
      configOverride,
      params.requesterSessionKey,
    );

    await callGatewayMock({
      method: "agent",
      params: {
        sessionKey: requesterSessionKey,
        message: `subagent task ${statusLabel}`,
        deliver: false,
      },
    });

    if (params.label) {
      await callGatewayMock({
        method: "sessions.patch",
        params: {
          key: params.childSessionKey,
          label: params.label,
        },
      });
    }

    if (params.cleanup === "delete") {
      await callGatewayMock({
        method: "sessions.delete",
        params: {
          key: params.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: params.spawnMode === "session",
        },
      });
    }

    return true;
  };
  const defaultCaptureSubagentCompletionReply: CaptureSubagentCompletionReply = async () =>
    undefined;
  const state = {
    get configOverride() {
      return configOverride;
    },
    set configOverride(next: SessionsSpawnTestConfig) {
      configOverride = next;
    },
    hookRunnerOverride: null as SessionsSpawnHookRunner,
    defaultCaptureSubagentCompletionReply,
    captureSubagentCompletionReplyOverride: defaultCaptureSubagentCompletionReply,
    defaultRunSubagentAnnounceFlow,
    runSubagentAnnounceFlowOverride: defaultRunSubagentAnnounceFlow,
  };
  return {
    callGatewayMock,
    defaultConfigOverride,
    nextRunId: () => {
      nextRunId += 1;
      return `run-${nextRunId}`;
    },
    sessionStore,
    state,
  };
});

let cachedCreateSessionsSpawnTool: CreateSessionsSpawnTool | null = null;
let cachedSubagentRegistryTesting: SubagentRegistryTesting | null = null;
let cachedSubagentSpawnTesting: SubagentSpawnTesting | null = null;

export function getCallGatewayMock(): Mock {
  return hoisted.callGatewayMock;
}

export function getGatewayRequests(): Array<GatewayRequest> {
  return getCallGatewayMock().mock.calls.map((call: unknown[]) => call[0] as GatewayRequest);
}

export function getGatewayMethods(): Array<string | undefined> {
  return getGatewayRequests().map((request) => request.method);
}

export function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

export function resetSessionsSpawnConfigOverride(): void {
  hoisted.state.configOverride = hoisted.defaultConfigOverride;
}

export function setSessionsSpawnConfigOverride(next: SessionsSpawnTestConfig): void {
  hoisted.state.configOverride = next;
}

export function resetSessionsSpawnAnnounceFlowOverride(): void {
  hoisted.state.runSubagentAnnounceFlowOverride = hoisted.state.defaultRunSubagentAnnounceFlow;
}

export function resetSessionsSpawnHookRunnerOverride(): void {
  hoisted.state.hookRunnerOverride = null;
}

export function setSessionsSpawnHookRunnerOverride(next: SessionsSpawnHookRunner): void {
  hoisted.state.hookRunnerOverride = next;
}

export function setSessionsSpawnAnnounceFlowOverride(next: RunSubagentAnnounceFlow): void {
  hoisted.state.runSubagentAnnounceFlowOverride = next;
}

export async function getSessionsSpawnTool(opts: CreateOpenClawToolsOpts) {
  if (!cachedSubagentSpawnTesting || !cachedSubagentRegistryTesting) {
    const [{ __testing: subagentSpawnTesting }, { __testing: subagentRegistryTesting }] =
      await Promise.all([import("./subagent-spawn.js"), import("./subagent-registry.js")]);
    cachedSubagentSpawnTesting = subagentSpawnTesting;
    cachedSubagentRegistryTesting = subagentRegistryTesting;
  }
  cachedSubagentSpawnTesting.setDepsForTest({
    callGateway: (optsUnknown) => hoisted.callGatewayMock(optsUnknown),
    getGlobalHookRunner: () => hoisted.state.hookRunnerOverride,
    loadConfig: () => hoisted.state.configOverride,
    updateSessionStore: async (_storePath, mutator) => mutator({}),
  });
  cachedSubagentRegistryTesting.setDepsForTest({
    callGateway: (optsUnknown) => hoisted.callGatewayMock(optsUnknown),
    loadConfig: () => hoisted.state.configOverride,
    cleanupBrowserSessionsForLifecycleEnd: async () => {},
    ensureContextEnginesInitialized: () => {},
    ensureRuntimePluginsLoaded: () => {},
    resolveContextEngine: async () => ({
      info: { id: "test", name: "Test" },
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      ingest: async () => ({ ingested: false }),
    }),
    captureSubagentCompletionReply: (sessionKey) =>
      hoisted.state.captureSubagentCompletionReplyOverride(sessionKey),
    runSubagentAnnounceFlow: (params) => hoisted.state.runSubagentAnnounceFlowOverride(params),
  });
  if (!cachedCreateSessionsSpawnTool) {
    ({ createSessionsSpawnTool: cachedCreateSessionsSpawnTool } =
      await import("./tools/sessions-spawn-tool.js"));
  }
  return cachedCreateSessionsSpawnTool(opts);
}

export function setupSessionsSpawnGatewayMock(setupOpts: SessionsSpawnGatewayMockOptions): {
  calls: Array<GatewayRequest>;
  waitCalls: Array<AgentWaitCall>;
  getChild: () => { runId?: string; sessionKey?: string };
} {
  const calls: Array<GatewayRequest> = [];
  const waitCalls: Array<AgentWaitCall> = [];
  let childRunId: string | undefined;
  let childSessionKey: string | undefined;

  getCallGatewayMock().mockImplementation(async (optsUnknown: unknown) => {
    const request = optsUnknown as GatewayRequest;
    calls.push(request);

    if (request.method === "sessions.list" && setupOpts.includeSessionsList) {
      return {
        sessions: [
          {
            key: "main",
            lastChannel: "whatsapp",
            lastTo: "+123",
          },
        ],
      };
    }

    if (request.method === "agent") {
      const runId = hoisted.nextRunId();
      const params = request.params as { lane?: string; sessionKey?: string } | undefined;
      // Capture only the subagent run metadata.
      if (params?.lane === "subagent") {
        childRunId = runId;
        childSessionKey = params.sessionKey ?? "";
        if (childSessionKey) {
          hoisted.sessionStore[childSessionKey] = {
            sessionId: `sess-${childSessionKey}`,
            updatedAt: Date.now(),
          };
        }
        setupOpts.onAgentSubagentSpawn?.(params);
      }
      return {
        runId,
        status: "accepted",
        acceptedAt: Date.now(),
      };
    }

    if (request.method === "agent.wait") {
      const params = request.params as AgentWaitCall | undefined;
      waitCalls.push(params ?? {});
      const waitResult = setupOpts.agentWaitResult ?? {
        status: "ok",
        startedAt: 1000,
        endedAt: 2000,
      };
      return {
        runId: params?.runId ?? "run-1",
        ...waitResult,
      };
    }

    if (request.method === "sessions.patch") {
      setupOpts.onSessionsPatch?.(request.params);
      return { ok: true };
    }

    if (request.method === "sessions.delete") {
      setupOpts.onSessionsDelete?.(request.params);
      return { ok: true };
    }

    if (request.method === "chat.history" && setupOpts.includeChatHistory) {
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: setupOpts.chatHistoryText ?? "done" }],
          },
        ],
      };
    }

    return {};
  });

  return {
    calls,
    waitCalls,
    getChild: () => ({ runId: childRunId, sessionKey: childSessionKey }),
  };
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));
// Some tools import callGateway via "../../gateway/call.js" (from nested folders). Mock that too.
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => hoisted.state.configOverride,
  resolveGatewayPort: () => 18789,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => hoisted.sessionStore,
  mergeSessionEntry: (existing: object | undefined, patch: object) => ({
    ...existing,
    ...patch,
  }),
  resolveAgentMainSessionKey: (params: {
    cfg?: { session?: { mainKey?: string } };
    agentId: string;
  }) => `agent:${params.agentId}:${params.cfg?.session?.mainKey ?? "main"}`,
  resolveStorePath: () => "/tmp/openclaw-sessions-spawn-test-store.json",
  updateSessionStore: async (
    _storePath: string,
    mutator: (store: typeof hoisted.sessionStore) => void | Promise<void>,
  ) => {
    await mutator(hoisted.sessionStore);
  },
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

// Same module, different specifier (used by tools under src/agents/tools/*).
vi.mock("../../config/config.js", () => ({
  loadConfig: () => hoisted.state.configOverride,
  resolveGatewayPort: () => 18789,
}));
