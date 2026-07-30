/**
 * Persists and normalizes the Codex app-server thread binding associated with
 * an OpenClaw session file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveDefaultAgentDir,
  resolveProviderIdForAuth,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { type FileLockOptions, withFileLock } from "openclaw/plugin-sdk/file-lock";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  normalizeCodexServiceTier,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./config.js";
import {
  readHostRuntimePreparedFactsRecord,
  type HostRuntimePreparedFacts,
} from "./host-runtime-envelope.js";
import type { TurnOwnerDecision } from "./mcp-thread-config.js";
import type { PluginAppPolicyContext } from "./plugin-thread-config.js";
import type { CodexServiceTier } from "./protocol.js";

const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";
export const CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const CODEX_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS = 1_000;
const CODEX_APP_SERVER_BINDING_LOCK_MIN_WAIT_MS =
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 15_000;
const CODEX_APP_SERVER_BINDING_LOCK_OPTIONS: FileLockOptions = {
  // Guarded native compaction holds this lock while sending thread/compact/start.
  // Wait beyond that bounded RPC so peer writes/clears block instead of timing out.
  retries: {
    retries: Math.ceil(
      CODEX_APP_SERVER_BINDING_LOCK_MIN_WAIT_MS / CODEX_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
    ),
    factor: 1,
    minTimeout: CODEX_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
    maxTimeout: CODEX_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
  },
  stale: CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS * 2,
};
const bindingMutationQueues = new Map<string, Promise<void>>();
const bindingMutationContext = new AsyncLocalStorage<Set<string>>();

type ProviderAuthAliasLookupParams = Parameters<typeof resolveProviderIdForAuth>[1];
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];

/** Inputs needed to resolve whether a binding's auth profile is native Codex/OpenAI auth. */
export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
};

/** Durable sidecar binding connecting an OpenClaw session file to a Codex thread. */
export type CodexAppServerThreadBinding = {
  schemaVersion: 2;
  threadId: string;
  sessionFile: string;
  cwd: string;
  authProfileId?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  networkProxyProfileName?: string;
  networkProxyConfigFingerprint?: string;
  dynamicToolsFingerprint?: string;
  dynamicToolsContainDeferred?: boolean;
  webSearchThreadConfigFingerprint?: string;
  userMcpServersFingerprint?: string;
  mcpServersFingerprint?: string;
  mcpOwnershipDecisions?: Record<string, TurnOwnerDecision>;
  hostRuntimePreparedFacts?: Record<string, HostRuntimePreparedFacts>;
  nativeHookRelayGeneration?: string;
  appServerRuntimeFingerprint?: string;
  pluginAppsFingerprint?: string;
  pluginAppsInputFingerprint?: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  contextEngine?: CodexAppServerContextEngineBinding;
  environmentSelectionFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

/** Context-engine state persisted with a Codex app-server thread binding. */
export type CodexAppServerContextEngineBinding = {
  schemaVersion: 1;
  engineId: string;
  policyFingerprint: string;
  projection?: CodexAppServerContextEngineProjectionBinding;
};

/** Context-engine projection metadata used to guard resumed native threads. */
export type CodexAppServerContextEngineProjectionBinding = {
  schemaVersion: 1;
  mode: "thread_bootstrap";
  epoch: string;
  fingerprint?: string;
};

/** Returns the JSON sidecar path for the Codex app-server binding beside a session file. */
export function resolveCodexAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.codex-app-server.json`;
}

/** Serializes mutation of the Codex app-server binding sidecar for a session file. */
export async function withCodexAppServerBindingLock<T>(
  sessionFile: string,
  run: () => Promise<T>,
): Promise<T> {
  const bindingPath = resolveCodexAppServerBindingPath(sessionFile);
  const ownedBindings = bindingMutationContext.getStore();
  if (ownedBindings?.has(bindingPath)) {
    return await withFileLock(bindingPath, CODEX_APP_SERVER_BINDING_LOCK_OPTIONS, run);
  }
  // The SDK file lock is process-reentrant, so pair it with a local queue.
  // Nested writes from the same guarded mutation can proceed, but unrelated
  // same-process tasks cannot slip between compare/clear/start.
  const previous = bindingMutationQueues.get(bindingPath) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  bindingMutationQueues.set(bindingPath, queued);
  await previous.catch(() => undefined);

  const nestedOwnedBindings = new Set(ownedBindings);
  nestedOwnedBindings.add(bindingPath);
  try {
    return await bindingMutationContext.run(nestedOwnedBindings, () =>
      withFileLock(bindingPath, CODEX_APP_SERVER_BINDING_LOCK_OPTIONS, run),
    );
  } finally {
    releaseCurrent();
    if (bindingMutationQueues.get(bindingPath) === queued) {
      bindingMutationQueues.delete(bindingPath);
    }
  }
}

/** Reads and normalizes a Codex app-server binding sidecar, returning undefined on stale data. */
export async function readCodexAppServerBinding(
  sessionFile: string,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<CodexAppServerThreadBinding | undefined> {
  const path = resolveCodexAppServerBindingPath(sessionFile);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    embeddedAgentLog.warn("failed to read codex app-server binding", { path, error });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const schemaVersion =
      parsed.schemaVersion === 1 || parsed.schemaVersion === 2 ? parsed.schemaVersion : undefined;
    if (schemaVersion === undefined || typeof parsed.threadId !== "string") {
      return undefined;
    }
    const authProfileId =
      typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined;
    return {
      schemaVersion: 2,
      threadId: parsed.threadId,
      sessionFile,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      authProfileId,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        ...lookup,
        authProfileId,
        modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
      }),
      approvalPolicy: readApprovalPolicy(parsed.approvalPolicy),
      sandbox: readSandboxMode(parsed.sandbox),
      serviceTier: readServiceTier(parsed.serviceTier),
      networkProxyProfileName:
        typeof parsed.networkProxyProfileName === "string"
          ? parsed.networkProxyProfileName
          : undefined,
      networkProxyConfigFingerprint:
        typeof parsed.networkProxyConfigFingerprint === "string"
          ? parsed.networkProxyConfigFingerprint
          : undefined,
      dynamicToolsFingerprint:
        typeof parsed.dynamicToolsFingerprint === "string"
          ? parsed.dynamicToolsFingerprint
          : undefined,
      dynamicToolsContainDeferred:
        typeof parsed.dynamicToolsContainDeferred === "boolean"
          ? parsed.dynamicToolsContainDeferred
          : undefined,
      webSearchThreadConfigFingerprint:
        typeof parsed.webSearchThreadConfigFingerprint === "string"
          ? parsed.webSearchThreadConfigFingerprint
          : undefined,
      userMcpServersFingerprint:
        typeof parsed.userMcpServersFingerprint === "string"
          ? parsed.userMcpServersFingerprint
          : undefined,
      mcpServersFingerprint:
        typeof parsed.mcpServersFingerprint === "string" ? parsed.mcpServersFingerprint : undefined,
      mcpOwnershipDecisions: readMcpOwnershipDecisions(parsed.mcpOwnershipDecisions),
      hostRuntimePreparedFacts: readHostRuntimePreparedFactsRecord(parsed.hostRuntimePreparedFacts),
      nativeHookRelayGeneration:
        typeof parsed.nativeHookRelayGeneration === "string" &&
        parsed.nativeHookRelayGeneration.trim()
          ? parsed.nativeHookRelayGeneration
          : undefined,
      appServerRuntimeFingerprint:
        typeof parsed.appServerRuntimeFingerprint === "string" &&
        parsed.appServerRuntimeFingerprint.trim()
          ? parsed.appServerRuntimeFingerprint
          : undefined,
      pluginAppsFingerprint:
        typeof parsed.pluginAppsFingerprint === "string" ? parsed.pluginAppsFingerprint : undefined,
      pluginAppsInputFingerprint:
        typeof parsed.pluginAppsInputFingerprint === "string"
          ? parsed.pluginAppsInputFingerprint
          : undefined,
      pluginAppPolicyContext: readPluginAppPolicyContext(
        parsed.pluginAppPolicyContext,
        schemaVersion,
      ),
      contextEngine: readContextEngineBinding(parsed.contextEngine),
      environmentSelectionFingerprint:
        typeof parsed.environmentSelectionFingerprint === "string"
          ? parsed.environmentSelectionFingerprint
          : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to parse codex app-server binding", { path, error });
    return undefined;
  }
}

/** Writes the Codex app-server binding sidecar with normalized provider/auth metadata. */
export async function writeCodexAppServerBinding(
  sessionFile: string,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"
  > & {
    createdAt?: string;
  },
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<void> {
  await withCodexAppServerBindingLock(sessionFile, async () => {
    const now = new Date().toISOString();
    const payload: CodexAppServerThreadBinding = {
      schemaVersion: 2,
      sessionFile,
      threadId: binding.threadId,
      cwd: binding.cwd,
      authProfileId: binding.authProfileId,
      model: binding.model,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        ...lookup,
        authProfileId: binding.authProfileId,
        modelProvider: binding.modelProvider,
      }),
      approvalPolicy: binding.approvalPolicy,
      sandbox: binding.sandbox,
      serviceTier: binding.serviceTier,
      networkProxyProfileName: binding.networkProxyProfileName,
      networkProxyConfigFingerprint: binding.networkProxyConfigFingerprint,
      dynamicToolsFingerprint: binding.dynamicToolsFingerprint,
      dynamicToolsContainDeferred: binding.dynamicToolsContainDeferred,
      webSearchThreadConfigFingerprint: binding.webSearchThreadConfigFingerprint,
      userMcpServersFingerprint: binding.userMcpServersFingerprint,
      mcpServersFingerprint: binding.mcpServersFingerprint,
      mcpOwnershipDecisions: binding.mcpOwnershipDecisions,
      hostRuntimePreparedFacts: binding.hostRuntimePreparedFacts,
      nativeHookRelayGeneration: binding.nativeHookRelayGeneration,
      appServerRuntimeFingerprint: binding.appServerRuntimeFingerprint,
      pluginAppsFingerprint: binding.pluginAppsFingerprint,
      pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
      pluginAppPolicyContext: binding.pluginAppPolicyContext,
      contextEngine: binding.contextEngine,
      environmentSelectionFingerprint: binding.environmentSelectionFingerprint,
      createdAt: binding.createdAt ?? now,
      updatedAt: now,
    };
    await fs.writeFile(
      resolveCodexAppServerBindingPath(sessionFile),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  });
}

function readContextEngineBinding(value: unknown): CodexAppServerContextEngineBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.engineId !== "string" ||
    typeof record.policyFingerprint !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    engineId: record.engineId,
    policyFingerprint: record.policyFingerprint,
    projection: readContextEngineProjectionBinding(record.projection),
  };
}

function readContextEngineProjectionBinding(
  value: unknown,
): CodexAppServerContextEngineProjectionBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.mode !== "thread_bootstrap" ||
    typeof record.epoch !== "string" ||
    !record.epoch.trim()
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    mode: "thread_bootstrap",
    epoch: record.epoch,
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : undefined,
  };
}

function readMcpOwnershipDecisions(value: unknown): Record<string, TurnOwnerDecision> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const decisions: Record<string, TurnOwnerDecision> = {};
  for (const [endpointId, rawDecision] of Object.entries(value)) {
    const decision = readTurnOwnerDecision(endpointId, rawDecision);
    if (!decision) {
      return undefined;
    }
    decisions[endpointId] = decision;
  }
  return decisions;
}

function readTurnOwnerDecision(endpointId: string, value: unknown): TurnOwnerDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const owner = readRuntimeEnvelopeOwner(record.owner);
  const reason = readTurnOwnerDecisionReason(record.reason);
  if (!owner || !reason || record.endpointId !== endpointId || typeof record.auditId !== "string") {
    return undefined;
  }
  const decision: TurnOwnerDecision = {
    owner,
    reason,
    endpointId,
    auditId: record.auditId,
  };
  if (typeof record.threadOwnerId === "string") {
    decision.threadOwnerId = record.threadOwnerId;
  }
  if (typeof record.dispatcherId === "string") {
    decision.dispatcherId = record.dispatcherId;
  }
  if (typeof record.hostId === "string") {
    decision.hostId = record.hostId;
  }
  return decision;
}

function readRuntimeEnvelopeOwner(value: unknown): TurnOwnerDecision["owner"] | undefined {
  return value === "openclaw" || value === "external-host" ? value : undefined;
}

function readTurnOwnerDecisionReason(value: unknown): TurnOwnerDecision["reason"] | undefined {
  return value === "endpoint-owner" ||
    value === "thread-owner" ||
    value === "dispatcher-decision" ||
    value === "standalone-default"
    ? value
    : undefined;
}

function readPluginAppPolicyContext(
  value: unknown,
  bindingSchemaVersion: 1 | 2,
): PluginAppPolicyContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fingerprint !== "string") {
    return undefined;
  }
  const apps = record.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) {
    return undefined;
  }
  const parsedApps: PluginAppPolicyContext["apps"] = {};
  for (const [appId, rawEntry] of Object.entries(apps)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return undefined;
    }
    const entry = rawEntry as Record<string, unknown>;
    const destructiveApprovalMode = readDestructiveApprovalMode(
      entry.destructiveApprovalMode,
      bindingSchemaVersion,
    );
    if (
      "appId" in entry ||
      typeof entry.configKey !== "string" ||
      entry.marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
      typeof entry.pluginName !== "string" ||
      typeof entry.allowDestructiveActions !== "boolean" ||
      destructiveApprovalMode === "invalid" ||
      !Array.isArray(entry.mcpServerNames) ||
      entry.mcpServerNames.some((serverName) => typeof serverName !== "string")
    ) {
      return undefined;
    }
    parsedApps[appId] = {
      configKey: entry.configKey,
      marketplaceName: entry.marketplaceName,
      pluginName: entry.pluginName,
      allowDestructiveActions: entry.allowDestructiveActions,
      ...(destructiveApprovalMode ? { destructiveApprovalMode } : {}),
      mcpServerNames: entry.mcpServerNames,
    };
  }
  const parsedPluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  const rawPluginAppIds = record.pluginAppIds;
  if (rawPluginAppIds && (typeof rawPluginAppIds !== "object" || Array.isArray(rawPluginAppIds))) {
    return undefined;
  }
  if (rawPluginAppIds && typeof rawPluginAppIds === "object") {
    for (const [configKey, appIds] of Object.entries(rawPluginAppIds)) {
      if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) {
        return undefined;
      }
      parsedPluginAppIds[configKey] = appIds;
    }
  }
  return {
    fingerprint: record.fingerprint,
    apps: parsedApps,
    pluginAppIds: parsedPluginAppIds,
  };
}

function readDestructiveApprovalMode(
  value: unknown,
  bindingSchemaVersion: 1 | 2,
): PluginAppPolicyContext["apps"][string]["destructiveApprovalMode"] | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  if (value === "deny") {
    return "deny";
  }
  if (value === "allow") {
    return "allow";
  }
  if (value === "auto") {
    return bindingSchemaVersion === 1 ? "allow" : "auto";
  }
  if (value === "on-request" && bindingSchemaVersion === 1) {
    return "auto";
  }
  return "invalid";
}

/** Removes the Codex app-server binding sidecar if present. */
export async function clearCodexAppServerBinding(
  sessionFile: string,
  _lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<void> {
  if (!(await codexAppServerBindingSidecarExists(sessionFile))) {
    return;
  }
  await withCodexAppServerBindingLock(sessionFile, async () => {
    await unlinkCodexAppServerBinding(sessionFile);
  });
}

async function codexAppServerBindingSidecarExists(sessionFile: string): Promise<boolean> {
  try {
    await fs.access(resolveCodexAppServerBindingPath(sessionFile));
    return true;
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn("failed to inspect codex app-server binding", { sessionFile, error });
    }
    return false;
  }
}

async function unlinkCodexAppServerBinding(sessionFile: string): Promise<boolean> {
  try {
    await fs.unlink(resolveCodexAppServerBindingPath(sessionFile));
    return true;
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn("failed to clear codex app-server binding", { sessionFile, error });
    }
    return false;
  }
}

/** Clears a binding only when it still points at the expected Codex thread id. */
export async function clearCodexAppServerBindingForThread(
  sessionFile: string,
  threadId: string,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<boolean> {
  if (!(await readCodexAppServerBinding(sessionFile, lookup))) {
    return false;
  }
  return await withCodexAppServerBindingLock(sessionFile, async () => {
    const binding = await readCodexAppServerBinding(sessionFile, lookup);
    if (!binding) {
      return false;
    }
    if (binding.threadId !== threadId) {
      embeddedAgentLog.debug("codex app-server binding points at a different thread; preserving", {
        sessionFile,
        threadId,
        boundThreadId: binding.threadId,
      });
      return false;
    }
    return await unlinkCodexAppServerBinding(sessionFile);
  });
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Returns true when an auth profile uses native Codex/OpenAI app-server auth. */
export function isCodexAppServerNativeAuthProfile(
  lookup: CodexAppServerAuthProfileLookup,
): boolean {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return false;
  }
  try {
    const credential = resolveCodexAppServerAuthProfileCredential({
      ...lookup,
      authProfileId,
    });
    if (!credential || credential.type === "api_key") {
      return false;
    }
    return isOpenAiAuthProvider({ provider: credential.provider, config: lookup.config });
  } catch (error) {
    embeddedAgentLog.debug("failed to resolve codex app-server auth profile provider", {
      authProfileId,
      error,
    });
    return false;
  }
}

/** Hides redundant OpenAI provider attribution for native Codex auth bindings. */
export function normalizeCodexAppServerBindingModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER
  ) {
    return undefined;
  }
  return modelProvider;
}

function resolveCodexAppServerAuthProfileCredential(
  lookup: CodexAppServerAuthProfileLookup,
): AuthProfileStore["profiles"][string] | undefined {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return undefined;
  }
  const store =
    lookup.authProfileStore ??
    loadCodexAppServerAuthProfileStore({
      agentDir: lookup.agentDir,
      authProfileId,
      config: lookup.config,
    });
  return store.profiles[authProfileId];
}

function loadCodexAppServerAuthProfileStore(params: {
  agentDir: string | undefined;
  authProfileId: string;
  config?: ProviderAuthAliasConfig;
}): AuthProfileStore {
  return ensureAuthProfileStore(
    params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {}),
    {
      allowKeychainPrompt: false,
      config: params.config,
      externalCliProviderIds: [CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER],
      externalCliProfileIds: [params.authProfileId],
    },
  );
}

function isOpenAiAuthProvider(params: {
  provider?: string;
  config?: ProviderAuthAliasConfig;
}): boolean {
  const provider = params.provider?.trim();
  return Boolean(
    provider &&
    resolveProviderIdForAuth(provider, { config: params.config }) ===
      CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER,
  );
}

function readApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  return value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
    ? value
    : undefined;
}

function readSandboxMode(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function readServiceTier(value: unknown): CodexServiceTier | undefined {
  return normalizeCodexServiceTier(value);
}
