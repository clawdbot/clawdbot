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
import type { SessionCatalogProvider as RegisteredSessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./app-server/auth-start-options.js";
import { resolveCodexAppServerUserHomeDir } from "./app-server/config.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type { CodexThread } from "./app-server/protocol.js";
import { sessionBindingIdentity } from "./app-server/session-binding.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexCatalogHomeResolver, type CodexCatalogHome } from "./session-catalog-homes.js";
import { listPairedNode } from "./session-catalog-node-continue.js";
import { catalogError, parseCatalogPage } from "./session-catalog-parsing.js";
import {
  CODEX_TERMINAL_RESUME_COMMAND,
  type CodexTerminalConfigSources,
} from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "./session-catalog-types.js";
import {
  CODEX_LOCAL_SESSION_HOST_ID,
  codexSessionCatalogRuntime,
  createCodexSessionCatalogControl as createCodexSessionCatalogControlFactory,
  createCodexSessionCatalogNodeHostCommands as createCodexSessionCatalogNodeHostCommandsRuntime,
  createCodexSessionCatalogNodeInvokePolicies,
} from "./session-catalog.js";

export const CODEX_APP_SERVER_THREADS_LIST_COMMAND = "codex.appServer.threads.list.v1";
export const CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND = "codex.appServer.thread.turns.list.v1";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";
export const CODEX_NODE_CONTINUE_COMMANDS = [
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CLI_SESSION_RESUME_COMMAND,
] as const;
const originalPath = process.env.PATH;
export const tempDirs: string[] = [];

beforeEach(() => {
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
  process.env.PATH = originalPath;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const archiveLocalCodexSession = codexSessionCatalogRuntime.archiveLocal;
const continueLocalCodexSessionRuntime = codexSessionCatalogRuntime.continueLocal;
const listCodexSessionCatalogRuntime = codexSessionCatalogRuntime.list;
const readCodexSessionTranscriptRuntime = codexSessionCatalogRuntime.readTranscript;
const registerCodexSessionCatalogRuntime = codexSessionCatalogRuntime.register;

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

export function continueLocalCodexSession(
  params: Omit<Parameters<typeof continueLocalCodexSessionRuntime>[0], "agentId"> & {
    agentId?: string;
  },
) {
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
    "control" | "getPluginConfig"
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
    control,
    getPluginConfig,
  });
}

export function createCodexSessionCatalogNodeHostCommands(
  control:
    | CodexSessionCatalogControl
    | CodexSessionCatalogControlFactory
    | CodexSessionCatalogControlFactoryStub,
  configSources: CodexTerminalConfigSources = {
    getPluginConfig: () => undefined,
    getRuntimeConfig: () => config,
  },
  bindingStore?: CodexAppServerBindingStore,
) {
  return createCodexSessionCatalogNodeHostCommandsRuntime(
    asControlFactory(control),
    configSources,
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
  let sessionSequence = 0;
  const createSessionEntry = vi.fn(async (createParams: CreateSessionEntryParams) => {
    const inputKey = createParams.key ?? "created";
    const agentId = createParams.agentId ?? "main";
    const key = inputKey.startsWith("agent:") ? inputKey : `agent:${agentId}:${inputKey}`;
    const existing = entries.find((candidate) => candidate.sessionKey === key);
    let summary: SessionEntrySummary;
    if (existing) {
      const entry = existing.entry;
      const initialHarnessId =
        "agentHarnessId" in createParams.initialEntry
          ? createParams.initialEntry.agentHarnessId
          : undefined;
      const initialMatches =
        createParams.recoverMatchingInitialEntry === true &&
        entry.initializationPending === true &&
        entry.agentHarnessId === initialHarnessId &&
        entry.modelSelectionLocked === createParams.initialEntry.modelSelectionLocked &&
        JSON.stringify(entry.pluginExtensions) ===
          JSON.stringify(createParams.initialEntry.pluginExtensions);
      if (!initialMatches) {
        throw new Error(`Session "${key}" does not match its trusted recovery state.`);
      }
      summary = existing;
    } else {
      sessionSequence += 1;
      const sessionId = `openclaw-session-${sessionSequence}`;
      const entry = {
        sessionId,
        sessionFile: `/tmp/${sessionId}.jsonl`,
        ...createParams.initialEntry,
        ...(createParams.afterCreate ? { initializationPending: true as const } : {}),
      } as CreateSessionEntryResult["entry"];
      summary = { sessionKey: key, entry };
      entries.push(summary);
    }
    const entry = summary.entry;
    const sessionId = entry.sessionId;
    const result = { key, agentId, sessionId, entry };
    try {
      const finalPatch = await createParams.afterCreate?.(result);
      if (existing && !finalPatch) {
        throw new Error("session creation recovery requires a final patch");
      }
      if (finalPatch) {
        entry.pluginExtensions = structuredClone(finalPatch.pluginExtensions);
      }
      delete entry.initializationPending;
      if (params.failAfterCreate?.() === true) {
        throw new Error("session finalization failed after binding commit");
      }
      return result;
    } catch (error) {
      const index = entries.indexOf(summary);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      throw error;
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
    nodes: {
      list: vi.fn(async () => ({ nodes: params.nodes ?? [] })),
      invoke: params.invoke ?? vi.fn(async () => ({})),
    },
    agent: {
      session: {
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
