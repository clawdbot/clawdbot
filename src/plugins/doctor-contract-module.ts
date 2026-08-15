import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  OpenKeyedStoreOptions,
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
};

export type PluginDoctorStateMigration = {
  id: string;
  label: string;
  /** Import retired file state only during explicit `doctor --fix` repair. */
  doctorOnly?: boolean;
  detectLegacyState: (params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
    context: PluginDoctorStateMigrationContext;
  }) =>
    | Promise<PluginDoctorStateMigrationDetection | null>
    | PluginDoctorStateMigrationDetection
    | null;
  migrateLegacyState: (params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
    context: PluginDoctorStateMigrationContext;
  }) =>
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
