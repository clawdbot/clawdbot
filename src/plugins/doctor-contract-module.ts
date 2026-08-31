import type { ChannelIngressQueue } from "../channels/message/ingress-queue.js";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorRawStateEntry,
  PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { coerceDoctorSessionRouteStateOwners } from "./doctor-session-route-state-owner-types.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";

export type PluginDoctorStateMigrationDetection = {
  preview: string[];
};

export type PluginDoctorStateMigrationContext = {
  openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  /** Doctor-only batch import preserving source age and remaining retention. */
  importPluginStateEntries?: (
    options: OpenKeyedStoreOptions,
    entries: readonly { key: string; value: unknown; createdAt: number; ttlMs?: number }[],
  ) => void;
  /** Plugin-wide live-row capacity for import preflight. Older test hosts may omit it. */
  getPluginStateCapacity?: () => { liveEntries: number; maxEntries: number };
  readPluginStateEntriesInKeyRange?: (
    namespace: string,
    range: { prefix: string; after?: string; limit: number },
  ) => PluginDoctorRawStateEntry[];
  readSessionIdentityEvidenceBatch?: (
    requests: readonly { agentId: string; sessionId: string }[],
  ) => Promise<
    (
      | { agentId: string; sessionId: string; state: "current"; sessionKey: string }
      | { agentId: string; sessionId: string; state: "absent" | "unknown" }
    )[]
  >;
  /** Present only while the host owns the offline SQLite maintenance lock. */
  deletePluginStateEntriesIfUnchanged?: (
    namespace: string,
    entries: readonly PluginDoctorRawStateEntry[],
  ) => { deleted: number; changed: number };
  /** Owner-bound ingress queue access, one entry per manifest-declared channel;
   *  the host fixes the channel identity and doctor state directory. Older test
   *  hosts may omit it. */
  channelIngressQueues?: readonly PluginDoctorChannelIngressQueueAccess[];
};

/** Read-only projection of a durable ingress queue. Detection runs before the host
    holds exclusive state ownership, so it is never handed anything wider. */
export type PluginDoctorChannelIngressQueueInspection<TPayload, TMetadata = unknown> = Pick<
  ChannelIngressQueue<TPayload, TMetadata>,
  "listPending" | "listClaims" | "listFailed"
>;

/** Doctor access to one host-bound channel's durable ingress queues. It mirrors
 *  the runtime proxy's accessor, minus the state-dir override the host fixes. */
export type PluginDoctorChannelIngressQueueAccess = {
  channelId: string;
  /** Inspection-only access, available in every phase including detection. */
  openChannelIngressQueueForInspection: <TPayload, TMetadata = unknown>(options?: {
    accountId?: string;
  }) => PluginDoctorChannelIngressQueueInspection<TPayload, TMetadata>;
  /** Account ids currently holding ingress rows, so migrations also sweep
   *  accounts retired from config. Async because detection resolves it through the
   *  non-creating read-only path. */
  listChannelIngressQueueAccountIds: () => Promise<string[]>;
  /** Present only while the host owns the exclusive Doctor maintenance lock. Every
   *  call re-asserts that authority, so a handle retained past the repair section
   *  fails instead of writing. */
  openChannelIngressQueue?: <
    TPayload,
    TMetadata = unknown,
    TCompletedMetadata = unknown,
  >(options?: {
    accountId?: string;
  }) => ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
};

type PluginDoctorStateMigrationInput = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
  context: PluginDoctorStateMigrationContext;
};

export type PluginDoctorStateMigration = {
  id: string;
  label: string;
  /** Import retired file state only during explicit `doctor --fix` repair. */
  doctorOnly?: boolean;
  phase?: "after-session-repair";
  detectLegacyState: (
    params: PluginDoctorStateMigrationInput,
  ) =>
    | Promise<PluginDoctorStateMigrationDetection | null>
    | PluginDoctorStateMigrationDetection
    | null;
  migrateLegacyState: (
    params: PluginDoctorStateMigrationInput,
  ) =>
    | Promise<{ changes: string[]; warnings: string[]; notices?: string[] }>
    | { changes: string[]; warnings: string[]; notices?: string[] };
};

export type PluginDoctorContractModule = {
  legacyConfigRules?: unknown;
  normalizeCompatibilityConfig?: unknown;
  resolveSessionStoreAgentIds?: unknown;
  /**
   * @deprecated Declare static ownership in openclaw.plugin.json sessionRouteStateOwners.
   * Removal plan: remove the module fallback in OpenClaw 2027.1 after external plugins migrate.
   */
  sessionRouteStateOwners?: unknown;
  stateMigrations?: unknown;
};

type PluginDoctorCompatibilityNormalizer = (params: { cfg: OpenClawConfig }) => {
  config: OpenClawConfig;
  changes: string[];
};

type PluginDoctorSessionStoreAgentIdsResolver = (params: {
  cfg: OpenClawConfig;
}) => readonly string[];

function coerceLegacyConfigRules(value: unknown): LegacyConfigRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as { path?: unknown; message?: unknown };
    return Array.isArray(candidate.path) && typeof candidate.message === "string";
  }) as LegacyConfigRule[];
}

function coerceNormalizeCompatibilityConfig(
  value: unknown,
): PluginDoctorCompatibilityNormalizer | undefined {
  return typeof value === "function" ? (value as PluginDoctorCompatibilityNormalizer) : undefined;
}

function coerceSessionStoreAgentIdsResolver(
  value: unknown,
): PluginDoctorSessionStoreAgentIdsResolver | undefined {
  return typeof value === "function"
    ? (value as PluginDoctorSessionStoreAgentIdsResolver)
    : undefined;
}

function isPluginDoctorStateMigration(value: unknown): value is PluginDoctorStateMigration {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    label?: unknown;
    detectLegacyState?: unknown;
    migrateLegacyState?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    typeof candidate.detectLegacyState === "function" &&
    typeof candidate.migrateLegacyState === "function"
  );
}

function coercePluginDoctorStateMigrations(value: unknown): PluginDoctorStateMigration[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPluginDoctorStateMigration).map((migration) => ({
    id: migration.id.trim(),
    label: migration.label.trim(),
    doctorOnly: migration.doctorOnly === true ? true : undefined,
    phase: migration.phase === "after-session-repair" ? migration.phase : undefined,
    detectLegacyState: migration.detectLegacyState,
    migrateLegacyState: migration.migrateLegacyState,
  }));
}

/** Coerce a loaded doctor contract once for both registry use and declaration validation. */
export function coercePluginDoctorContractModule(mod: PluginDoctorContractModule) {
  const defaultExport = (mod as { default?: PluginDoctorContractModule }).default;
  const rules = coerceLegacyConfigRules(defaultExport?.legacyConfigRules ?? mod.legacyConfigRules);
  const normalizeCompatibilityConfig = coerceNormalizeCompatibilityConfig(
    mod.normalizeCompatibilityConfig ?? defaultExport?.normalizeCompatibilityConfig,
  );
  const resolveSessionStoreAgentIds = coerceSessionStoreAgentIdsResolver(
    mod.resolveSessionStoreAgentIds ?? defaultExport?.resolveSessionStoreAgentIds,
  );
  const sessionRouteStateOwners = coerceDoctorSessionRouteStateOwners(
    mod.sessionRouteStateOwners ?? defaultExport?.sessionRouteStateOwners,
  );
  const stateMigrations = coercePluginDoctorStateMigrations(
    mod.stateMigrations ?? defaultExport?.stateMigrations,
  );
  const summary: Record<keyof PluginManifestDoctorContract, boolean> = {
    configRepair: rules.length > 0 || Boolean(normalizeCompatibilityConfig),
    resolveSessionStoreAgentIds: Boolean(resolveSessionStoreAgentIds),
    sessionRouteStateOwners: sessionRouteStateOwners.length > 0,
    stateMigrations: stateMigrations.length > 0,
  };
  return {
    rules,
    normalizeCompatibilityConfig,
    resolveSessionStoreAgentIds,
    sessionRouteStateOwners,
    stateMigrations,
    summary,
  };
}
