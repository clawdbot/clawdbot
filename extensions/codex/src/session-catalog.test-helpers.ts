// Register narrow mocks before any production imports evaluate the catalog graph.
// oxfmt-ignore
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  transcriptMirrorMocks,
  nodeHostMocks,
} from "./session-catalog.test-mocks.js";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createCapturedPluginRegistration,
  createEmptyPluginRegistry,
  createPluginRecord,
  getActivePluginRegistry,
  setActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { SessionCatalogProvider as RegisteredSessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../harness.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./app-server/auth-start-options.js";
import {
  resolveCodexAppServerUserHomeDir,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./app-server/config.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type { CodexThread, CodexThreadItem } from "./app-server/protocol.js";
import { sessionBindingIdentity } from "./app-server/session-binding.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.test-helpers.js";
import {
  createCodexCatalogHomeResolver as createCodexCatalogHomeResolverRuntime,
  type CodexCatalogHome,
} from "./session-catalog-homes.js";
import { listPairedNode } from "./session-catalog-node-continue.js";
import { catalogError, parseCatalogPage } from "./session-catalog-parsing.js";
import {
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_TERMINAL_START_COMMAND,
  type CodexTerminalConfigSources,
} from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "./session-catalog-types.js";
import {
  CODEX_LOCAL_SESSION_HOST_ID,
  codexSessionCatalogRuntime,
  createCodexSessionCatalogControl as createCodexSessionCatalogControlRuntime,
  createCodexSessionCatalogNodeHostCommands as createCodexSessionCatalogNodeHostCommandsRuntime,
  createCodexSessionCatalogNodeInvokePolicies,
} from "./session-catalog.js";

export const CODEX_APP_SERVER_THREADS_LIST_COMMAND = "codex.appServer.threads.list.v1";
export const CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND = "codex.appServer.thread.turns.list.v1";
export const CODEX_CATALOG_TRANSCRIPT_READ_COMMAND = "codex.sessionCatalog.transcript.read.v1";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";
export const CODEX_NODE_CONTINUE_COMMANDS = [
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CLI_SESSION_RESUME_COMMAND,
] as const;
const originalPath = process.env.PATH;
export const tempDirs: string[] = [];

beforeEach(() => {
  const stateDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-owner-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  nodeHostMocks.runNodePtyCommand.mockClear();
  nodeHostMocks.userShellPaths.clear();
  commandRpcMocks.codexControlRequest.mockReset();
  pinnedConnectionMocks.getClient.mockReset();
  pinnedConnectionMocks.getClient.mockResolvedValue(pinnedConnectionMocks.client);
  pinnedConnectionMocks.releaseClient.mockReset();
  pinnedConnectionMocks.request.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockResolvedValue({
    importedMessages: 0,
    omittedMessages: 0,
  });
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  process.env.PATH = originalPath;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const archiveLocalCodexSession = codexSessionCatalogRuntime.archiveLocal;
const continueLocalCodexSessionRuntime = codexSessionCatalogRuntime.continueLocal;
const listCodexSessionCatalogRuntime = codexSessionCatalogRuntime.list;
const readCodexSessionTranscriptRuntime = codexSessionCatalogRuntime.readTranscript;
const registerCodexSessionCatalogRuntime = codexSessionCatalogRuntime.register;

function createCodexSessionCatalogControlFactory(
  params: Omit<
    Parameters<typeof createCodexSessionCatalogControlRuntime>[0],
    "resolveRuntimeOptions"
  >,
) {
  return createCodexSessionCatalogControlRuntime({
    ...params,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
  });
}

function createCodexCatalogHomeResolver(
  params: Omit<
    Parameters<typeof createCodexCatalogHomeResolverRuntime>[0],
    "resolveRuntimeOptions"
  >,
) {
  return createCodexCatalogHomeResolverRuntime({
    ...params,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
  });
}

export function createCodexSessionCatalogControl(
  params: Parameters<typeof createCodexSessionCatalogControlFactory>[0],
): CodexSessionCatalogControl {
  const config = params.getRuntimeConfig() ?? {};
  return createCodexSessionCatalogControlFactory(params).forRequest(
    resolveSessionAgentIdsStrict({ config }).sessionAgentId,
  );
}

type CodexSessionCatalogControlFactoryStub = Pick<CodexSessionCatalogControlFactory, "forRequest">;

function asControlFactory(
  control:
    | CodexSessionCatalogControl
    | CodexSessionCatalogControlFactory
    | CodexSessionCatalogControlFactoryStub,
): CodexSessionCatalogControlFactory {
  if ("homesForAgent" in control) {
    return control;
  }
  const forRequest = "forRequest" in control ? control.forRequest : () => control;
  return {
    forRequest,
    homesForAgent: () => [],
    forUpstream: (agentId) => forRequest(agentId),
  };
}

export function listCodexSessionCatalog(
  params: Omit<Parameters<typeof listCodexSessionCatalogRuntime>[0], "control"> & {
    control:
      | CodexSessionCatalogControl
      | CodexSessionCatalogControlFactory
      | CodexSessionCatalogControlFactoryStub;
  },
) {
  return listCodexSessionCatalogRuntime({ ...params, control: asControlFactory(params.control) });
}

const catalogOwners = new WeakMap<
  CodexAppServerBindingStore,
  ReturnType<typeof createEmptyPluginRegistry>
>();

export function continueLocalCodexSession(
  params: Omit<Parameters<typeof continueLocalCodexSessionRuntime>[0], "agentId"> & {
    agentId?: string;
  },
) {
  let registry = catalogOwners.get(params.bindingStore);
  if (!registry) {
    registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "codex" }));
    registry.agentHarnesses.push({
      pluginId: "codex",
      source: "runtime",
      harness: createCodexAppServerAgentHarness({
        bindingStore: params.bindingStore,
        runtime: params.api.runtime,
      }),
    });
    catalogOwners.set(params.bindingStore, registry);
  }
  if (getActivePluginRegistry() !== registry) {
    setActivePluginRegistry(registry);
  }
  return continueLocalCodexSessionRuntime({
    ...params,
    agentId:
      params.agentId ?? resolveSessionAgentIdsStrict({ config: params.config }).sessionAgentId,
  });
}

export function readCodexSessionTranscript(
  params: Omit<Parameters<typeof readCodexSessionTranscriptRuntime>[0], "agentId"> & {
    agentId?: string;
  },
) {
  return readCodexSessionTranscriptRuntime({ ...params, agentId: params.agentId ?? "main" });
}

export function registerCodexSessionCatalog(
  params: Omit<
    Parameters<typeof registerCodexSessionCatalogRuntime>[0],
    "control" | "getPluginConfig" | "resolveRuntimeOptions"
  > & {
    control:
      | CodexSessionCatalogControl
      | CodexSessionCatalogControlFactory
      | CodexSessionCatalogControlFactoryStub;
    getPluginConfig?: () => unknown;
  },
) {
  const getPluginConfig = params.getPluginConfig ?? (() => undefined);
  const baseControl = asControlFactory(params.control);
  const control =
    "homesForAgent" in params.control
      ? baseControl
      : (() => {
          const resolver = createCodexCatalogHomeResolver({
            config: params.getRuntimeConfig() ?? (params.api.config as OpenClawConfig),
            getRuntimeConfig: params.getRuntimeConfig,
            getPluginConfig,
          });
          return {
            ...baseControl,
            homesForAgent: (agentId: string) => resolver.forAgent(agentId),
          } satisfies CodexSessionCatalogControlFactory;
        })();
  return registerCodexSessionCatalogRuntime({
    ...params,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    control,
    getPluginConfig,
  });
}

export function createCodexSessionCatalogNodeHostCommands(
  control:
    | CodexSessionCatalogControl
    | CodexSessionCatalogControlFactory
    | CodexSessionCatalogControlFactoryStub,
  configSources: Omit<CodexTerminalConfigSources, "resolveRuntimeOptions"> = {
    getPluginConfig: () => undefined,
    getRuntimeConfig: () => config,
  },
  bindingStore?: CodexAppServerBindingStore,
) {
  return createCodexSessionCatalogNodeHostCommandsRuntime(
    asControlFactory(control),
    { ...configSources, resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions },
    bindingStore,
  );
}

type CreateSessionEntryParams = Parameters<
  PluginRuntime["agent"]["session"]["createSessionEntry"]
>[0];
type CreateSessionEntryResult = Awaited<
  ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>
>;
type PatchSessionEntryParams = Parameters<
  PluginRuntime["agent"]["session"]["patchSessionEntry"]
>[0];
type SessionEntrySummary = ReturnType<
  PluginRuntime["agent"]["session"]["listSessionEntries"]
>[number];

type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
type SessionCatalogProvider = Omit<
  RegisteredSessionCatalogProvider,
  "list" | "read" | "continueSession" | "archive" | "openTerminal"
> & {
  list: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["list"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["list"]>;
  read: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["read"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["read"]>;
  continueSession?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>;
  archive?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["archive"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["archive"]>>;
  openTerminal?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>;
};

function bindTestCatalogOwner(provider: RegisteredSessionCatalogProvider): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(provider.continueSession
      ? {
          continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
        }
      : {}),
    ...(provider.archive
      ? { archive: (params) => provider.archive!({ agentId: "main", ...params }) }
      : {}),
    ...(provider.openTerminal
      ? {
          openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
        }
      : {}),
  } as SessionCatalogProvider;
}

export const config = {} as OpenClawConfig;

export function compatibilityOwnerConfig(owner = "alpha"): OpenClawConfig {
  return {
    agents: {
      list: ["alpha", "beta"].map((id) => (id === owner ? { id, default: true } : { id })),
    },
  } as OpenClawConfig;
}

export async function normalizeCodexManifestConfig(
  value: unknown,
): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  const result = validateJsonSchemaValue({
    cacheKey: "codex.session-catalog.manifest-config",
    schema: manifest.configSchema,
    value,
    applyDefaults: true,
  });
  if (!result.ok) {
    throw new Error(
      `Expected valid Codex manifest config: ${result.errors.map((error) => error.text).join(", ")}`,
    );
  }
  return result.value as Record<string, unknown>;
}

export function idleThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    name: "Continue native task",
    cwd: "/workspace/project",
    projectId: null,
    status: { type: "idle" },
    ...overrides,
  };
}

export function catalogThreadItem(
  id: string,
  overrides: Partial<CodexThreadItem> = {},
): CodexThreadItem {
  return {
    id,
    type: "agentMessage",
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
    ...overrides,
  };
}

export function createControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  const withPinnedConnection = vi.fn(
    async (run: (value: CodexSessionCatalogControl) => Promise<unknown>) => await run(control),
  ) as unknown as CodexSessionCatalogControl["withPinnedConnection"];
  const control = {
    connectionFingerprint: "catalog-connection",
    withPinnedConnection,
    requireEligibleThread: vi.fn(async (threadId: string) => idleThread({ id: threadId })),
    listPage: vi.fn(async () => ({ sessions: [] })),
    listDescendantPage: vi.fn(async () => ({ data: [] })),
    listTurnPage: vi.fn(async () => ({ data: [] })),
    listItemPage: vi.fn(async () => ({ data: [] })),
    readThread: vi.fn(async (threadId: string) => idleThread({ id: threadId })),
    archiveThread: vi.fn(async () => undefined),
    ...overrides,
  } as CodexSessionCatalogControl;
  return control;
}

export function createEligibleControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  return createControl({
    listPage: vi.fn(async () => ({
      sessions: [{ threadId: "thread-1", status: "idle", source: "cli", archived: false as const }],
    })),
    ...overrides,
  });
}

export function adoptedEntry(params: {
  sourceThreadId: string;
  sourceHomeId?: string;
  sessionId?: string;
}) {
  return {
    sessionId: params.sessionId ?? "openclaw-session-existing",
    updatedAt: 1,
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          ...(params.sourceHomeId ? { sourceHomeId: params.sourceHomeId } : {}),
          modelLocked: true,
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

export function supervisionSessionInputKey(threadId: string, sourceHomeId?: string): string {
  const digest = createHash("sha256")
    .update(sourceHomeId ? JSON.stringify([sourceHomeId, threadId]) : threadId)
    .digest("hex");
  return `harness:codex:supervision:${digest}`;
}

export function supervisionSessionKey(threadId: string, sourceHomeId?: string): string {
  return `agent:main:${supervisionSessionInputKey(threadId, sourceHomeId)}`;
}

export async function seedSupervisionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  sessionId: string;
  sessionKey: string;
  sourceThreadId: string;
  pending?: boolean;
}): Promise<void> {
  const binding: CodexAppServerThreadBinding = {
    threadId: params.pending ? params.sourceThreadId : `${params.sourceThreadId}-branch`,
    connectionScope: "supervision",
    supervisionSourceThreadId: params.sourceThreadId,
    cwd: "/workspace/project",
    conversationSourceTransferComplete: true,
    preserveNativeModel: true,
    historyCoveredThrough: new Date().toISOString(),
    ...(params.pending
      ? {
          pendingSupervisionBranch: {
            sourceThreadId: params.sourceThreadId,
            connectionFingerprint: "catalog-connection",
          },
        }
      : { model: "gpt-5.4", modelProvider: "openai" }),
  };
  const stored = await params.bindingStore.mutate(
    sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config,
    }),
    { kind: "set", if: { kind: "absent" }, binding },
  );
  if (!stored) {
    throw new Error(`failed to seed supervision binding for ${params.sourceThreadId}`);
  }
}

export function interruptedAdoptionEntry(params: { sourceThreadId: string; sessionId: string }) {
  return {
    sessionId: params.sessionId,
    sessionFile: `/tmp/${params.sessionId}.jsonl`,
    updatedAt: 1,
    initializationPending: true,
    spawnedCwd: "/workspace/project",
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          initializing: true,
          modelLocked: true,
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

export function createRuntime(
  params: {
    entries?: SessionEntrySummary[];
    nodes?: Array<Record<string, unknown>>;
    invoke?: PluginRuntime["nodes"]["invoke"];
    failAfterCreate?: () => boolean;
  } = {},
) {
  const entries = params.entries ?? [];
  const capturedRuntime = createCapturedPluginRegistration({ id: "codex" }).api.runtime;
  const session = capturedRuntime.agent.session;
  const createSessionEntry = vi.fn(async (createParams: CreateSessionEntryParams) => {
    const agentId = createParams.agentId ?? "main";
    const storePath = resolveStorePath(createParams.cfg.session?.store, { agentId });
    const key = createParams.key.startsWith("agent:")
      ? createParams.key
      : `agent:${agentId}:${createParams.key}`;
    for (const summary of entries.filter((candidate) =>
      candidate.sessionKey.startsWith(`agent:${agentId}:`),
    )) {
      await session.upsertSessionEntry({
        sessionKey: summary.sessionKey,
        storePath,
        entry: { ...summary.entry, updatedAt: Date.now() },
      });
    }
    const refresh = () => {
      const entry = session.getSessionEntry({
        sessionKey: key,
        storePath,
        readConsistency: "latest",
      });
      const index = entries.findIndex((summary) => summary.sessionKey === key);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      if (entry) {
        entries.push({ sessionKey: key, entry });
      }
    };
    try {
      return await session.createSessionEntry({
        ...createParams,
        afterCreate: async (created) => {
          refresh();
          const patch = await createParams.afterCreate?.(created);
          if (params.failAfterCreate?.()) {
            throw new Error("session finalization failed after binding commit");
          }
          if (!patch) {
            throw new Error("catalog fixture requires its initializer's final patch");
          }
          return patch;
        },
      });
    } finally {
      refresh();
    }
  });
  const patchSessionEntry = vi.fn(async (patchParams: PatchSessionEntryParams) => {
    const summary = entries.find((candidate) => candidate.sessionKey === patchParams.sessionKey);
    if (!summary) {
      return null;
    }
    const current = structuredClone(summary.entry);
    const patch = await patchParams.update(current, { existingEntry: structuredClone(current) });
    if (!patch) {
      return summary.entry;
    }
    const next = { ...summary.entry, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        Reflect.deleteProperty(next, key);
      }
    }
    summary.entry = next;
    return next;
  });
  const runtime = {
    modelConfig: capturedRuntime.modelConfig,
    nodes: {
      list: vi.fn(async () => ({ nodes: params.nodes ?? [] })),
      invoke: params.invoke ?? vi.fn(async () => ({})),
    },
    agent: {
      session: {
        getSessionEntry: session.getSessionEntry,
        createSessionEntry,
        listSessionEntries: vi.fn((listParams) => {
          const agentPrefix = listParams?.agentId ? `agent:${listParams.agentId}:` : undefined;
          return entries.filter(
            ({ sessionKey }) => !agentPrefix || sessionKey.startsWith(agentPrefix),
          );
        }),
        patchSessionEntry,
      },
    },
  } as unknown as PluginRuntime;
  return { runtime, entries, createSessionEntry, patchSessionEntry };
}

export function archiveTestSession(params: {
  control: CodexSessionCatalogControl;
  agentId?: string;
  config?: OpenClawConfig;
  bindingStore?: CodexAppServerBindingStore;
  runtime?: PluginRuntime;
  threadId?: string;
}) {
  const archiveConfig = params.config ?? config;
  return archiveLocalCodexSession({
    agentId:
      params.agentId ?? resolveSessionAgentIdsStrict({ config: archiveConfig }).sessionAgentId,
    bindingStore: params.bindingStore ?? createCodexTestBindingStore(),
    config: archiveConfig,
    control: params.control,
    runtime: params.runtime ?? createRuntime().runtime,
    threadId: params.threadId ?? "thread-1",
  });
}

export function createGatewayApi(runtime: PluginRuntime, apiConfig: OpenClawConfig = {}) {
  let provider: SessionCatalogProvider | undefined;
  const registerSessionCatalog = vi.fn((candidate: RegisteredSessionCatalogProvider) => {
    provider = bindTestCatalogOwner(candidate);
  });
  const api = {
    config: apiConfig,
    runtime,
    registerSessionCatalog,
  } as unknown as OpenClawPluginApi;
  return { api, getProvider: () => provider, registerSessionCatalog };
}

export {
  commandRpcMocks,
  pinnedConnectionMocks,
  transcriptMirrorMocks,
  nodeHostMocks,
  fs,
  fsSync,
  os,
  path,
  resolveAgentDir,
  resolveSessionAgentIdsStrict,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
  resolveCodexAppServerUserHomeDir,
  resolveDefaultAgentDir,
  resolveStorePath,
  sessionBindingIdentity,
  withEnvAsync,
  createCodexCatalogHomeResolver,
  createCodexTestBindingStore,
  buildCodexAppServerConnectionFingerprint,
  listPairedNode,
  catalogError,
  parseCatalogPage,
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_TERMINAL_START_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  createCodexSessionCatalogControlFactory,
  createCodexSessionCatalogNodeInvokePolicies,
};
export type {
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
  CodexCatalogHome,
  CodexThread,
  OpenClawConfig,
  PluginRuntime,
};
