// Memory Wiki compiled cache ownership and persistence.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { WikiFreshnessLevel } from "./claim-health.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type { WikiPageKind, WikiPageSummary, WikiRelationship } from "./markdown.js";

const COMPILED_CACHE_NAMESPACE = "compiled-cache";
const COMPILED_CACHE_MAX_ENTRIES = 256;
const COMPILED_CACHE_MAX_BYTES_PER_ENTRY = 100 * 1024 * 1024;
const COMPILED_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const COMPILED_CACHE_VERSION = 3;
export const MEMORY_WIKI_DASHBOARD_ITEM_LIMIT = 2_500;

export type MemoryWikiCompiledDigestClaim = {
  id?: string;
  text: string;
  status: string;
  confidence?: number;
  freshnessLevel: WikiFreshnessLevel;
};

export type MemoryWikiCompiledDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageKind;
  path: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases: string[];
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  privacyTier?: string;
  personCard?: WikiPageSummary["personCard"];
  bestUsedFor: string[];
  notEnoughFor: string[];
  relationshipCount: number;
  topRelationships: WikiRelationship[];
  claimCount: number;
  topClaims: MemoryWikiCompiledDigestClaim[];
};

export type MemoryWikiCompiledClaim = {
  id?: string;
  pageId?: string;
  pageTitle: string;
  pageKind: WikiPageKind;
  pagePath: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  text: string;
  status?: string;
  confidence?: number;
  sourceIds?: string[];
  evidenceKinds?: string[];
  privacyTiers?: string[];
  freshnessLevel?: string;
  lastTouchedAt?: string;
};

export type MemoryWikiImportInsightItem = {
  pagePath: string;
  title: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskReasons: string[];
  labels: string[];
  topicKey: string;
  topicLabel: string;
  digestStatus: "available" | "withheld";
  activeBranchMessages: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserLine?: string;
  lastUserLine?: string;
  assistantOpener?: string;
  summary: string;
  candidateSignals: string[];
  correctionSignals: string[];
  preferenceSignals: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryWikiImportInsightCluster = {
  key: string;
  label: string;
  itemCount: number;
  highRiskCount: number;
  withheldCount: number;
  preferenceSignalCount: number;
  updatedAt?: string;
  items: MemoryWikiImportInsightItem[];
};

export type MemoryWikiImportInsightsStatus = {
  sourceType: "chatgpt";
  totalItems: number;
  totalClusters: number;
  clusters: MemoryWikiImportInsightCluster[];
  truncated: boolean;
};

export type MemoryWikiOverviewItem = {
  pagePath: string;
  title: string;
  kind: WikiPageKind;
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

export type MemoryWikiOverviewCluster = {
  key: WikiPageKind;
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: MemoryWikiOverviewItem[];
};

export type MemoryWikiOverviewPageCounts = Record<WikiPageKind, number>;

export type MemoryWikiOverviewStatus = {
  totalItems: number;
  totalPages: number;
  pageCounts: MemoryWikiOverviewPageCounts;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  clusters: MemoryWikiOverviewCluster[];
  truncated: boolean;
};

export type MemoryWikiCompiledCacheSnapshot = {
  digest: {
    claimCount: number;
    contradictionCount: number;
    pages: MemoryWikiCompiledDigestPage[];
  };
  claims: MemoryWikiCompiledClaim[];
  dashboards: {
    importInsights: MemoryWikiImportInsightsStatus;
    overview: MemoryWikiOverviewStatus;
  };
};

type MemoryWikiCompiledDashboards = MemoryWikiCompiledCacheSnapshot["dashboards"];

export type MemoryWikiDashboardState =
  | { state: "ready"; dashboards: MemoryWikiCompiledDashboards }
  | { state: "rebuilding" }
  | { state: "compile-required" }
  | { state: "failed" };

type MemoryWikiDashboardPendingState = Exclude<MemoryWikiDashboardState, { state: "ready" }>;
const DASHBOARD_UNAVAILABLE_MESSAGES: Record<MemoryWikiDashboardPendingState["state"], string> = {
  rebuilding: "Memory Wiki dashboards are rebuilding. Retry shortly.",
  "compile-required":
    'Memory Wiki dashboards need a compiled snapshot. Run "openclaw wiki compile", then reload.',
  failed: 'Memory Wiki dashboard rebuild failed. Run "openclaw wiki compile", then reload.',
};

export class MemoryWikiDashboardUnavailableError extends Error {
  constructor(
    readonly state: MemoryWikiDashboardPendingState["state"],
    message: string,
  ) {
    super(message);
    this.name = "MemoryWikiDashboardUnavailableError";
  }
}

type CompiledCacheMetadata = {
  version: typeof COMPILED_CACHE_VERSION;
  ownerId: string;
  vaultPath: string;
  vaultGeneration: string;
  publicationId: string;
  generation: string;
  encoding: "gzip-json";
};

type ActiveVault = {
  path: string;
  vaultGeneration: string;
  compiledCachePublicationId?: string;
  reconciled: boolean;
  snapshot?: MemoryWikiCompiledCacheSnapshot;
};

type MemoryWikiCompiledCacheStore = {
  read(config: ResolvedMemoryWikiConfig): Promise<MemoryWikiCompiledCacheSnapshot | null>;
  write(
    config: ResolvedMemoryWikiConfig,
    snapshot: MemoryWikiCompiledCacheSnapshot,
    generation: string,
    publicationId: string,
  ): Promise<ActiveVault>;
  reconcile(
    config: ResolvedMemoryWikiConfig,
    loadDurableIdentity: () => Promise<{
      vaultGeneration: string | null;
      compiledCachePublicationId: string | null;
    }>,
  ): Promise<void>;
  delete(config: ResolvedMemoryWikiConfig): Promise<void>;
  deletePublication(config: ResolvedMemoryWikiConfig, publicationId: string): Promise<void>;
  deleteOwnersExcept(ownerIds: ReadonlySet<string>): Promise<number>;
};

let configuredStore: MemoryWikiCompiledCacheStore | undefined;
const activeVaults = new Map<string, ActiveVault>();
const dashboardStates = new Map<
  string,
  { ownerId: string; state: MemoryWikiDashboardPendingState }
>();

export function resolveMemoryWikiCompiledCacheOwnerId(config: ResolvedMemoryWikiConfig): string {
  if (config.vault.scope === "global") {
    return "global";
  }
  const agentId = config.agentId?.trim();
  if (!agentId) {
    throw new Error("Memory Wiki agent-scoped compiled cache requires an agent owner.");
  }
  return `agent:${agentId}`;
}

function ownerKeyPrefix(ownerId: string): string {
  return `owner:${createHash("sha256").update(ownerId).digest("hex")}:publication:`;
}

function publicationKey(ownerId: string, publicationId: string): string {
  return `${ownerKeyPrefix(ownerId)}${createHash("sha256").update(publicationId).digest("hex")}`;
}

function dashboardStateKey(config: ResolvedMemoryWikiConfig): string {
  return `${resolveMemoryWikiCompiledCacheOwnerId(config)}\0${path.resolve(config.vault.path)}`;
}

function isMetadata(value: CompiledCacheMetadata | undefined): value is CompiledCacheMetadata {
  return (
    value?.version === COMPILED_CACHE_VERSION &&
    typeof value.ownerId === "string" &&
    typeof value.vaultPath === "string" &&
    typeof value.vaultGeneration === "string" &&
    typeof value.publicationId === "string" &&
    typeof value.generation === "string" &&
    value.encoding === "gzip-json"
  );
}

export function activateMemoryWikiCompiledCacheOwner(
  config: ResolvedMemoryWikiConfig,
  vaultGeneration: string,
  compiledCachePublicationId?: string | null,
): boolean {
  const normalizedVaultGeneration = vaultGeneration.trim();
  if (!normalizedVaultGeneration) {
    throw new Error("Memory Wiki vault generation must not be empty.");
  }
  const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
  const vaultPath = path.resolve(config.vault.path);
  const publicationId = compiledCachePublicationId?.trim() || undefined;
  const active = activeVaults.get(ownerId);
  if (
    active?.reconciled &&
    active.path === vaultPath &&
    active.vaultGeneration === normalizedVaultGeneration &&
    active.compiledCachePublicationId === publicationId
  ) {
    return false;
  }
  activeVaults.set(ownerId, {
    path: vaultPath,
    vaultGeneration: normalizedVaultGeneration,
    compiledCachePublicationId: publicationId,
    reconciled: false,
  });
  return true;
}

export function deactivateMemoryWikiCompiledCacheOwnersExcept(ownerIds: ReadonlySet<string>): void {
  for (const ownerId of activeVaults.keys()) {
    if (!ownerIds.has(ownerId)) {
      activeVaults.delete(ownerId);
    }
  }
  for (const [key, entry] of dashboardStates) {
    if (!ownerIds.has(entry.ownerId)) {
      dashboardStates.delete(key);
    }
  }
}

export function setMemoryWikiDashboardState(
  config: ResolvedMemoryWikiConfig,
  state: MemoryWikiDashboardPendingState,
): void {
  dashboardStates.set(dashboardStateKey(config), {
    ownerId: resolveMemoryWikiCompiledCacheOwnerId(config),
    state,
  });
}

function resolveActiveVault(config: ResolvedMemoryWikiConfig): ActiveVault | null {
  const active = activeVaults.get(resolveMemoryWikiCompiledCacheOwnerId(config));
  if (!active || active.path !== path.resolve(config.vault.path)) {
    return null;
  }
  return active;
}

function parseSnapshot(
  bytes: Uint8Array,
  generation: string,
): MemoryWikiCompiledCacheSnapshot | null {
  try {
    const serialized = gunzipSync(bytes).toString("utf8");
    if (createHash("sha256").update(serialized).digest("hex") !== generation) {
      return null;
    }
    const parsed = JSON.parse(serialized) as MemoryWikiCompiledCacheSnapshot;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.digest ||
      typeof parsed.digest !== "object" ||
      !Array.isArray(parsed.digest.pages) ||
      !Array.isArray(parsed.claims) ||
      !parsed.dashboards ||
      typeof parsed.dashboards !== "object" ||
      !parsed.dashboards.importInsights ||
      typeof parsed.dashboards.importInsights !== "object" ||
      typeof parsed.dashboards.importInsights.truncated !== "boolean" ||
      !Array.isArray(parsed.dashboards.importInsights.clusters) ||
      !parsed.dashboards.overview ||
      typeof parsed.dashboards.overview !== "object" ||
      typeof parsed.dashboards.overview.truncated !== "boolean" ||
      !Array.isArray(parsed.dashboards.overview.clusters)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function resolveMemoryWikiCompiledCacheGeneration(
  snapshot: MemoryWikiCompiledCacheSnapshot,
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function createMemoryWikiCompiledCachePublicationId(): string {
  return randomUUID();
}

export function createMemoryWikiCompiledCacheStore(
  openBlobStore: <TMetadata>(options: {
    namespace: string;
    maxEntries: number;
    maxBytesPerEntry: number;
    maxBytesPerNamespace: number;
    overflowPolicy: "evict-oldest";
  }) => PluginBlobStore<TMetadata>,
  options: { onReadError?: (error: unknown) => void } = {},
): MemoryWikiCompiledCacheStore {
  const store = openBlobStore<CompiledCacheMetadata>({
    namespace: COMPILED_CACHE_NAMESPACE,
    maxEntries: COMPILED_CACHE_MAX_ENTRIES,
    maxBytesPerEntry: COMPILED_CACHE_MAX_BYTES_PER_ENTRY,
    maxBytesPerNamespace: COMPILED_CACHE_MAX_BYTES,
    overflowPolicy: "evict-oldest",
  });
  async function deleteKey(key: string): Promise<void> {
    await store.delete(key);
  }

  return {
    async read(config) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const activeVault = resolveActiveVault(config);
      if (!activeVault?.reconciled || !activeVault.compiledCachePublicationId) {
        return null;
      }
      if (activeVault.snapshot) {
        return activeVault.snapshot;
      }
      const key = publicationKey(ownerId, activeVault.compiledCachePublicationId);
      const entry = await store.lookup(key).catch((error: unknown) => {
        options.onReadError?.(error);
        throw error;
      });
      if (!entry) {
        return null;
      }
      const metadata = entry.metadata;
      const vaultPath = path.resolve(config.vault.path);
      if (!isMetadata(metadata) || metadata.ownerId !== ownerId) {
        return null;
      }
      // Compile or lifecycle refresh owns source changes; prompt preparation never polls files.
      // Every run still binds SQLite to that owner snapshot before exposing immutable lines.
      if (
        metadata.vaultPath !== vaultPath ||
        metadata.vaultGeneration !== activeVault.vaultGeneration
      ) {
        return null;
      }
      if (metadata.publicationId !== activeVault.compiledCachePublicationId) {
        return null;
      }
      const snapshot = parseSnapshot(entry.bytes, metadata.generation);
      if (!snapshot) {
        return null;
      }
      if (resolveActiveVault(config) !== activeVault) {
        return null;
      }
      activeVault.snapshot = snapshot;
      return snapshot;
    },

    async write(config, snapshot, generation, publicationId) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const vaultPath = path.resolve(config.vault.path);
      const activeVault = resolveActiveVault(config);
      if (!activeVault) {
        throw new Error(`Memory Wiki vault is not active: ${vaultPath}`);
      }
      const serialized = JSON.stringify(snapshot);
      if (createHash("sha256").update(serialized).digest("hex") !== generation) {
        throw new Error("Memory Wiki compiled cache generation does not match its snapshot.");
      }
      const metadata: CompiledCacheMetadata = {
        version: COMPILED_CACHE_VERSION,
        ownerId,
        vaultPath,
        vaultGeneration: activeVault.vaultGeneration,
        publicationId,
        generation,
        encoding: "gzip-json",
      };
      await store.register(publicationKey(ownerId, publicationId), gzipSync(serialized), metadata);
      return activeVault;
    },

    async reconcile(config, loadDurableIdentity) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const activeVault = resolveActiveVault(config);
      if (!activeVault) {
        return;
      }
      const durableIdentity = await loadDurableIdentity();
      if (durableIdentity.compiledCachePublicationId) {
        try {
          await store.lookup(publicationKey(ownerId, durableIdentity.compiledCachePublicationId));
        } catch (error) {
          options.onReadError?.(error);
          throw error;
        }
      }
      const confirmedIdentity = await loadDurableIdentity();
      if (resolveActiveVault(config) !== activeVault) {
        return;
      }
      if (
        !confirmedIdentity.vaultGeneration ||
        confirmedIdentity.vaultGeneration !== durableIdentity.vaultGeneration ||
        confirmedIdentity.compiledCachePublicationId !== durableIdentity.compiledCachePublicationId
      ) {
        activeVaults.delete(ownerId);
        return;
      }
      // SQLite is observed before the durable identity reread. A cross-process write that
      // races this boundary stays unreadable until the next lifecycle refresh.
      activeVaults.set(ownerId, {
        path: activeVault.path,
        vaultGeneration: confirmedIdentity.vaultGeneration,
        compiledCachePublicationId: confirmedIdentity.compiledCachePublicationId ?? undefined,
        reconciled: true,
      });
    },

    async delete(config) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      for (const entry of await store.entries()) {
        if (isMetadata(entry.metadata) && entry.metadata.ownerId === ownerId) {
          await deleteKey(entry.key);
        }
      }
    },

    async deletePublication(config, publicationId) {
      await deleteKey(publicationKey(resolveMemoryWikiCompiledCacheOwnerId(config), publicationId));
    },

    async deleteOwnersExcept(ownerIds) {
      let deleted = 0;
      for (const entry of await store.entries()) {
        const metadata = entry.metadata;
        if (isMetadata(metadata) && ownerIds.has(metadata.ownerId)) {
          continue;
        }
        await deleteKey(entry.key);
        deleted += 1;
      }
      return deleted;
    },
  };
}

export function configureMemoryWikiCompiledCacheStore(
  store: MemoryWikiCompiledCacheStore | undefined,
): void {
  configuredStore = store;
  if (!store) {
    activeVaults.clear();
    dashboardStates.clear();
  }
}

function requireConfiguredStore(): MemoryWikiCompiledCacheStore {
  if (!configuredStore) {
    throw new Error("Memory Wiki compiled cache store is not configured.");
  }
  return configuredStore;
}

export async function loadMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiCompiledCacheSnapshot | null> {
  return await requireConfiguredStore().read(config);
}

export async function readMemoryWikiDashboardState(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiDashboardState> {
  const pending = dashboardStates.get(dashboardStateKey(config));
  if (pending) {
    return pending.state;
  }
  try {
    const snapshot = await loadMemoryWikiCompiledCache(config);
    if (snapshot) {
      return { state: "ready", dashboards: snapshot.dashboards };
    }
  } catch {
    return { state: "failed" };
  }
  return config.ingest.autoCompile ? { state: "rebuilding" } : { state: "compile-required" };
}

export async function loadMemoryWikiCompiledDashboards(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiCompiledDashboards> {
  const status = await readMemoryWikiDashboardState(config);
  if (status.state === "ready") {
    return status.dashboards;
  }
  throw new MemoryWikiDashboardUnavailableError(
    status.state,
    DASHBOARD_UNAVAILABLE_MESSAGES[status.state],
  );
}

export async function invalidateMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
): Promise<void> {
  await requireConfiguredStore().delete(config);
  activeVaults.delete(resolveMemoryWikiCompiledCacheOwnerId(config));
  dashboardStates.delete(dashboardStateKey(config));
}

export async function reconcileMemoryWikiCompiledCacheOwner(
  config: ResolvedMemoryWikiConfig,
  loadDurableIdentity: () => Promise<{
    vaultGeneration: string | null;
    compiledCachePublicationId: string | null;
  }>,
): Promise<void> {
  await requireConfiguredStore().reconcile(config, loadDurableIdentity);
}

export async function writeMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
  snapshot: MemoryWikiCompiledCacheSnapshot,
  generation: string,
  publicationId: string,
  parentPublicationId: string | null,
  validatePublication: () => Promise<void>,
  commitPublication: () => Promise<void>,
  loadDurableIdentity: () => Promise<{
    vaultGeneration: string | null;
    compiledCachePublicationId: string | null;
  }>,
): Promise<void> {
  const store = requireConfiguredStore();
  const activeVault = await store.write(config, snapshot, generation, publicationId);
  try {
    await validatePublication();
  } catch (error) {
    await store.deletePublication(config, publicationId);
    throw error;
  }
  if (resolveActiveVault(config) !== activeVault) {
    await store.deletePublication(config, publicationId);
    throw new Error("Memory Wiki cache owner retired before publication.");
  }
  try {
    await commitPublication();
  } catch (error) {
    const identity = await loadDurableIdentity().catch(() => undefined);
    if (identity?.compiledCachePublicationId !== publicationId) {
      await store.deletePublication(config, publicationId);
    }
    throw error;
  }
  // The publication committed. If validation fails, retain its immutable row
  // so a later lifecycle refresh can reconcile it.
  const durableIdentity = await loadDurableIdentity();
  if (
    durableIdentity.vaultGeneration !== activeVault.vaultGeneration ||
    durableIdentity.compiledCachePublicationId !== publicationId
  ) {
    await store.deletePublication(config, publicationId);
    if (resolveActiveVault(config) === activeVault) {
      activeVaults.delete(resolveMemoryWikiCompiledCacheOwnerId(config));
    }
    throw new Error("Memory Wiki vault changed while its compiled cache was being published.");
  }
  if (resolveActiveVault(config) !== activeVault) {
    await store.deletePublication(config, publicationId);
    throw new Error("Memory Wiki cache owner retired during publication.");
  }
  if (parentPublicationId) {
    await store.deletePublication(config, parentPublicationId);
  }
  if (resolveActiveVault(config) !== activeVault) {
    await store.deletePublication(config, publicationId);
    throw new Error("Memory Wiki cache owner retired while replacing its predecessor.");
  }
  activeVaults.set(resolveMemoryWikiCompiledCacheOwnerId(config), {
    ...activeVault,
    compiledCachePublicationId: publicationId,
    reconciled: true,
    snapshot,
  });
  dashboardStates.delete(dashboardStateKey(config));
}
