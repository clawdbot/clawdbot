import {
  asNullableRecord as asConfigRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ConfigSnapshot, ConfigUiHints } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { normalizeAgentId } from "../sessions/session-key.ts";

export type ConfigAutoSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict" | "paused";
export type RuntimeConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configRawOriginalParsed: Record<string, unknown> | null;
  configRawOriginalParsePending: Promise<void> | null;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  configAutoSaveStatus: ConfigAutoSaveStatus;
  /** True when the config file revision differs from the active Gateway runtime. */
  configNeedsApply: boolean;
  configSnapshot: ConfigSnapshot | null;
  configDraftBaseHash?: string | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  lastError: string | null;
  chatError?: string | null;
};

const requestVersionsByState = new WeakMap<
  RuntimeConfigState,
  { config: number; schema: number }
>();
const connectionEpochsByState = new WeakMap<object, number>();

type RuntimeConfigGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  phase: ApplicationGatewayPhase;
  sessionKey: string;
  hello?: GatewayHelloOk | null;
};

export type RuntimeConfigGateway = {
  readonly snapshot: RuntimeConfigGatewaySnapshot;
  subscribe: (listener: (snapshot: RuntimeConfigGatewaySnapshot) => void) => () => void;
};

export type LoadConfigOptions = {
  discardPendingChanges?: boolean;
};

export type ConfigGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ConfigConnectionState = {
  client: ConfigGatewayClient | null;
  connected: boolean;
};

export function createInitialConfigState(
  snapshot?: Partial<RuntimeConfigGatewaySnapshot>,
): RuntimeConfigState {
  return {
    client: snapshot?.client ?? null,
    connected: snapshot?.phase === "connected",
    applySessionKey: snapshot?.sessionKey ?? "main",
    configLoading: false,
    configRaw: "{\n}\n",
    configRawOriginal: "",
    configRawOriginalParsed: null,
    configRawOriginalParsePending: null,
    configValid: null,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    configAutoSaveStatus: "idle",
    configNeedsApply: false,
    configSnapshot: null,
    configDraftBaseHash: null,
    configSchema: null,
    configSchemaVersion: null,
    configSchemaLoading: false,
    configUiHints: {},
    configForm: null,
    configFormOriginal: null,
    configFormDirty: false,
    configFormMode: "form",
    configSearchQuery: "",
    configActiveSection: null,
    configActiveSubsection: null,
    lastError: null,
  };
}

export function nextRequestVersion(state: RuntimeConfigState, key: "config" | "schema"): number {
  const current = requestVersionsByState.get(state) ?? { config: 0, schema: 0 };
  const next = { ...current, [key]: current[key] + 1 };
  requestVersionsByState.set(state, next);
  return next[key];
}

export function clearConfigRequestVersions(state: RuntimeConfigState): void {
  requestVersionsByState.delete(state);
}

export function currentConfigConnectionEpoch(state: object): number {
  return connectionEpochsByState.get(state) ?? 0;
}

export function invalidateConfigConnection(state: object): void {
  connectionEpochsByState.set(state, currentConfigConnectionEpoch(state) + 1);
}

export function isCurrentConfigConnection(
  state: ConfigConnectionState,
  client: ConfigGatewayClient,
  connectionEpoch: number,
): boolean {
  return (
    state.connected &&
    state.client === client &&
    currentConfigConnectionEpoch(state) === connectionEpoch
  );
}

export function isCurrentRequest(
  state: RuntimeConfigState,
  key: "config" | "schema",
  version: number,
  client: GatewayBrowserClient,
  connectionEpoch: number,
): boolean {
  return (
    isCurrentConfigConnection(state, client, connectionEpoch) &&
    requestVersionsByState.get(state)?.[key] === version
  );
}

/** Resolves true only when a current-epoch snapshot was actually applied. */
export function resolveEditableSnapshotConfig(
  snapshot: ConfigSnapshot | null | undefined,
): Record<string, unknown> | null {
  return (
    asConfigRecord(snapshot?.sourceConfig) ??
    asConfigRecord(snapshot?.resolved) ??
    asConfigRecord(snapshot?.config)
  );
}

export function currentConfigObject(
  state: Pick<RuntimeConfigState, "configForm" | "configSnapshot">,
): Record<string, unknown> | null {
  return state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
}
export type AgentConfigEntryTarget = {
  path: ["agents", "entries", string];
  entry: Record<string, unknown>;
};

const AGENT_CONFIG_ENTRY_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const BLOCKED_AGENT_CONFIG_ENTRY_IDS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeAgentConfigEntryId(agentId: string): string | null {
  const trimmedAgentId = agentId.trim();
  if (
    !AGENT_CONFIG_ENTRY_ID_PATTERN.test(trimmedAgentId) ||
    BLOCKED_AGENT_CONFIG_ENTRY_IDS.has(trimmedAgentId)
  ) {
    return null;
  }
  const normalizedAgentId = normalizeAgentId(trimmedAgentId);
  return BLOCKED_AGENT_CONFIG_ENTRY_IDS.has(normalizedAgentId) ? null : normalizedAgentId;
}

export function resolveAgentConfigEntryTarget(
  config: Record<string, unknown> | null,
  agentId: string,
): AgentConfigEntryTarget | null {
  const normalizedAgentId = normalizeAgentConfigEntryId(agentId);
  if (!normalizedAgentId) {
    return null;
  }
  const agents = isRecord(config?.agents) ? config.agents : null;
  const entries = isRecord(agents?.entries) ? agents.entries : null;
  const authoredAgentId = Object.keys(entries ?? {}).find(
    (candidate) =>
      AGENT_CONFIG_ENTRY_ID_PATTERN.test(candidate) &&
      !BLOCKED_AGENT_CONFIG_ENTRY_IDS.has(candidate) &&
      normalizeAgentId(candidate) === normalizedAgentId,
  );
  if (!entries || !authoredAgentId || !Object.hasOwn(entries, authoredAgentId)) {
    return null;
  }
  const entry = entries[authoredAgentId];
  if (!isRecord(entry)) {
    return null;
  }
  return {
    path: ["agents", "entries", authoredAgentId],
    entry,
  };
}

export function agentConfigEntry(
  state: RuntimeConfigState,
  agentId: string,
  options: { ensure?: boolean } = {},
): AgentConfigEntryTarget | null {
  const normalizedAgentId = normalizeAgentConfigEntryId(agentId);
  if (!normalizedAgentId) {
    return null;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const existing = resolveAgentConfigEntryTarget(source, normalizedAgentId);
  if (existing) {
    return existing;
  }
  if (!options.ensure) {
    return null;
  }
  const path = ["agents", "entries", normalizedAgentId] as const;
  return { path: [...path], entry: {} };
}
