import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
} from "../../../agents/auth-profiles/oauth-shared.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  parseLegacyCredentialEntry,
} from "../../../agents/auth-profiles/persisted.js";
import {
  applySessionEntryReplacements,
  listSessionEntriesForCanonicalRepair,
  listSessionEntriesReadOnly,
} from "../../../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadJsonFileThroughSymlink } from "../../../infra/json-file.js";
import {
  loadLegacySessionStore,
  updateLegacySessionStore,
} from "../../../infra/state-migrations.legacy-session-store.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../../sessions/agent-harness-session-key.js";
import { resolveLegacyAuthProfilesPath } from "../../doctor-auth-legacy-paths.js";
import {
  isOpenAICodexAuthProfileRef,
  isBlockedLegacyCodexModelPair,
  isBlockedLegacyCodexModelRef,
  isOpenAICodexModelRef,
  isLegacyCodexProviderId,
  isProviderlessModelRef,
  normalizeRuntimeString,
  toCanonicalOpenAIModelRef,
  toOpenAIModelId,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import type {
  CodexSessionRouteRepairSummary,
  SessionRouteRepairResult,
} from "./codex-route-types.js";

function rewriteSessionModelPair(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): boolean {
  let changed = false;
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  const legacyProviderModelRef =
    sessionProviderAllowsScopedModelRef(provider) && isOpenAICodexModelRef(model)
      ? model
      : undefined;
  const blockedIdentity =
    isBlockedLegacyCodexModelPair({
      providerId: provider,
      modelId: model,
      blockedModelIdentities: params.blockedModelIdentities,
    }) ||
    (legacyProviderModelRef
      ? isBlockedLegacyCodexModelRef({
          modelRef: legacyProviderModelRef,
          blockedModelIdentities: params.blockedModelIdentities,
        })
      : false);
  if (blockedIdentity) {
    return false;
  }
  if (isLegacyCodexProviderId(provider)) {
    params.entry[params.providerKey] = "openai";
    if (model) {
      const modelId = toOpenAIModelId(model);
      if (modelId) {
        params.entry[params.modelKey] = modelId;
      }
    }
    return true;
  }
  if (legacyProviderModelRef) {
    const canonicalModel =
      provider === "openai"
        ? toOpenAIModelId(legacyProviderModelRef)
        : toCanonicalOpenAIModelRef(legacyProviderModelRef);
    if (canonicalModel) {
      params.entry[params.modelKey] = canonicalModel;
      changed = true;
    }
  }
  return changed;
}

function sessionProviderAllowsScopedModelRef(provider: string | undefined): boolean {
  // Canonical "openai" pairs keep raw model ids untouched: a configured
  // OpenAI-compatible model may legitimately be ID'd "codex/<x>". Only an
  // absent or legacy provider field marks the model string as a scoped ref.
  return !provider || isLegacyCodexProviderId(provider);
}

function sessionModelPairHasLegacyRoute(provider: unknown, model: unknown): boolean {
  const normalizedProvider = normalizeString(provider);
  return (
    isLegacyCodexProviderId(normalizedProvider) ||
    (sessionProviderAllowsScopedModelRef(normalizedProvider) &&
      typeof model === "string" &&
      isOpenAICodexModelRef(model))
  );
}

function clearStaleCodexFallbackNotice(
  entry: SessionEntry,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): boolean {
  const endpoints = [entry.fallbackNotice?.selectedModel, entry.fallbackNotice?.activeModel];
  const hasBlockedEndpoint = endpoints.some(
    (modelRef) =>
      isOpenAICodexModelRef(modelRef) &&
      isBlockedLegacyCodexModelRef({ modelRef, blockedModelIdentities }),
  );
  if (hasBlockedEndpoint || !endpoints.some(isOpenAICodexModelRef)) {
    return false;
  }
  delete entry.fallbackNotice;
  return true;
}

function preserveRepairedSessionRuntimeIntent(entry: SessionEntry): boolean {
  const harnessRuntime = normalizeRuntimeString(entry.agentHarnessId);
  const overrideRuntime = normalizeRuntimeString(entry.agentRuntimeOverride);
  let changed = false;
  if (entry.agentHarnessId !== undefined && harnessRuntime !== "openclaw") {
    delete entry.agentHarnessId;
    changed = true;
  }
  if (overrideRuntime !== "openclaw" && entry.agentRuntimeOverride !== "codex") {
    entry.agentRuntimeOverride = "codex";
    changed = true;
  }
  return changed;
}

function repairProviderlessCodexSessionOverride(
  entry: SessionEntry,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): boolean {
  if (
    !isProviderlessModelRef(entry.modelOverride) ||
    !isOpenAICodexAuthProfileRef(entry.authProfileOverride) ||
    entry.authProfileOverrideSource !== "auto" ||
    entry.modelOverrideSource !== "auto" ||
    normalizeString(entry.providerOverride)
  ) {
    return false;
  }
  const authProvider = normalizeString(entry.authProfileOverride)?.split(":", 1)[0];
  if (
    isBlockedLegacyCodexModelPair({
      providerId: authProvider,
      modelId: entry.modelOverride,
      blockedModelIdentities,
    })
  ) {
    return false;
  }

  entry.providerOverride = "openai";
  entry.modelOverrideRouteResolution = "resolved";
  if (entry.model !== undefined || entry.modelProvider !== undefined) {
    delete entry.model;
    delete entry.modelProvider;
  }
  if (entry.contextTokens !== undefined) {
    delete entry.contextTokens;
  }
  if (entry.contextBudgetStatus !== undefined) {
    delete entry.contextBudgetStatus;
  }
  return true;
}

/** Rewrite stale Codex model/provider/session runtime fields inside one session store object. */
function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  now?: number;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  authProfileIdMap?: ReadonlyMap<string, string>;
}): SessionRouteRepairResult {
  const now = params.now ?? Date.now();
  const sessionKeys: string[] = [];
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry || isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      continue;
    }
    const changedRuntimeModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "modelProvider",
      modelKey: "model",
      blockedModelIdentities: params.blockedModelIdentities,
    });
    const changedOverrideModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "providerOverride",
      modelKey: "modelOverride",
      blockedModelIdentities: params.blockedModelIdentities,
    });
    if (changedOverrideModelRoute) {
      entry.modelOverrideRouteResolution = "resolved";
    }
    const changedProviderlessOverride = repairProviderlessCodexSessionOverride(
      entry,
      params.blockedModelIdentities,
    );
    const changedModelRoute =
      changedRuntimeModelRoute || changedOverrideModelRoute || changedProviderlessOverride;
    const changedFallbackNotice = clearStaleCodexFallbackNotice(
      entry,
      params.blockedModelIdentities,
    );
    const changedRuntimePins = changedModelRoute
      ? preserveRepairedSessionRuntimeIntent(entry)
      : false;
    // Providerless route repair first needs the legacy profile prefix; only the
    // auth migration owner's exact collision-aware map may rewrite its identity.
    const mappedAuthProfileId =
      typeof entry.authProfileOverride === "string"
        ? params.authProfileIdMap?.get(entry.authProfileOverride)
        : undefined;
    const changedAuthProfile =
      mappedAuthProfileId !== undefined && mappedAuthProfileId !== entry.authProfileOverride;
    if (changedAuthProfile) {
      entry.authProfileOverride = mappedAuthProfileId;
    }
    if (
      !changedModelRoute &&
      !changedFallbackNotice &&
      !changedRuntimePins &&
      !changedAuthProfile
    ) {
      continue;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.codexRouteSessionRepairTestApi")
  ] = { repairCodexSessionStoreRoutes };
}

function scanCodexSessionStoreRoutes(
  store: Record<string, SessionEntry>,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
  authProfileIdMap?: ReadonlyMap<string, string>,
): string[] {
  return Object.entries(store).flatMap(([sessionKey, entry]) => {
    if (!entry || isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      return [];
    }
    const isBlockedPair = (provider: unknown, model: unknown) => {
      const normalizedProvider = normalizeString(provider);
      const legacyProviderModelRef =
        sessionProviderAllowsScopedModelRef(normalizedProvider) &&
        typeof model === "string" &&
        isOpenAICodexModelRef(model)
          ? model
          : undefined;
      return (
        isBlockedLegacyCodexModelPair({
          providerId: provider,
          modelId: model,
          blockedModelIdentities,
        }) ||
        (legacyProviderModelRef &&
          isBlockedLegacyCodexModelRef({
            modelRef: legacyProviderModelRef,
            blockedModelIdentities,
          }))
      );
    };
    const fallbackNoticeEndpoints = [
      entry.fallbackNotice?.selectedModel,
      entry.fallbackNotice?.activeModel,
    ];
    const hasBlockedFallbackNoticeEndpoint = fallbackNoticeEndpoints.some(
      (modelRef) =>
        isOpenAICodexModelRef(modelRef) &&
        isBlockedLegacyCodexModelRef({ modelRef, blockedModelIdentities }),
    );
    const hasRewritableFallbackNotice =
      !hasBlockedFallbackNoticeEndpoint && fallbackNoticeEndpoints.some(isOpenAICodexModelRef);
    const hasLegacyRoute =
      (sessionModelPairHasLegacyRoute(entry.modelProvider, entry.model) &&
        !isBlockedPair(entry.modelProvider, entry.model)) ||
      (sessionModelPairHasLegacyRoute(entry.providerOverride, entry.modelOverride) &&
        !isBlockedPair(entry.providerOverride, entry.modelOverride)) ||
      (isProviderlessModelRef(entry.modelOverride) &&
        isOpenAICodexAuthProfileRef(entry.authProfileOverride) &&
        entry.authProfileOverrideSource === "auto" &&
        entry.modelOverrideSource === "auto" &&
        !normalizeString(entry.providerOverride) &&
        !isBlockedPair(
          normalizeString(entry.authProfileOverride)?.split(":", 1)[0],
          entry.modelOverride,
        )) ||
      (typeof entry.authProfileOverride === "string" &&
        authProfileIdMap?.has(entry.authProfileOverride)) ||
      hasRewritableFallbackNotice;
    return hasLegacyRoute ? [sessionKey] : [];
  });
}

function resolveVerifiedSessionAuthProfileIdMap(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authProfileIdMap: ReadonlyMap<string, string> | undefined;
}): ReadonlyMap<string, string> | undefined {
  if (!params.authProfileIdMap || params.authProfileIdMap.size === 0) {
    return params.authProfileIdMap;
  }
  const agentDir = resolveAgentDir(params.cfg, params.agentId, params.env);
  const localProfiles = loadPersistedAuthProfileStore(agentDir)?.profiles ?? {};
  const mainProfiles = loadPersistedSharedAuthProfileStore(params.env)?.profiles ?? {};
  const localLegacyAuthPath = resolveLegacyAuthProfilesPath(agentDir);
  const localLegacySourceExists = fs.existsSync(localLegacyAuthPath);
  const localLegacySource = localLegacySourceExists
    ? loadJsonFileThroughSymlink(localLegacyAuthPath)
    : null;
  const localLegacyProfiles =
    isRecord(localLegacySource) && isRecord(localLegacySource.profiles)
      ? localLegacySource.profiles
      : undefined;

  return new Map(
    [...params.authProfileIdMap].filter(([legacyProfileId, canonicalProfileId]) => {
      const localCredential = localProfiles[canonicalProfileId];
      if (localCredential) {
        return normalizeString(localCredential.provider) === "openai";
      }
      // A failed local import still owns its account. Never replace it with a
      // same-named main credential; inheritance is safe only without that source.
      const inheritedCredential = mainProfiles[canonicalProfileId];
      if (localLegacySourceExists) {
        if (!localLegacyProfiles) {
          return false;
        }
        const legacyCredential = localLegacyProfiles[legacyProfileId];
        if (legacyCredential !== undefined) {
          if (!isRecord(legacyCredential)) {
            return false;
          }
          const canonicalLegacyCredential = parseLegacyCredentialEntry(
            { ...legacyCredential, provider: "openai" },
            "openai",
          );
          // A retained mixed-sidecar source still contains successful entries.
          // Permit deduped main inheritance only when exact account identity matches.
          return (
            canonicalLegacyCredential?.type === "oauth" &&
            inheritedCredential?.type === "oauth" &&
            inheritedCredential.provider === "openai" &&
            (hasMatchingOAuthIdentity(canonicalLegacyCredential, inheritedCredential) ||
              areOAuthCredentialsEquivalent(canonicalLegacyCredential, inheritedCredential))
          );
        }
      }
      return normalizeString(inheritedCredential?.provider) === "openai";
    }),
  );
}

/** Scan or repair all configured agent session stores that still contain legacy Codex routes. */
export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  authProfileIdMap?: ReadonlyMap<string, string>;
}): Promise<CodexSessionRouteRepairSummary> {
  const env = params.env ?? process.env;
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env }).flatMap((target) => {
    const sessionScope = {
      storePath: target.storePath,
      agentId: target.agentId,
      env,
    };
    // Preview cannot canonicalize legacy rows; its doctor-only inventory must
    // remain readable without weakening strict post-migration repair writes.
    const sqliteEntries = params.shouldRepair
      ? listSessionEntriesReadOnly(sessionScope)
      : listSessionEntriesForCanonicalRepair(sessionScope);
    const hasLegacyStore = fs.existsSync(target.storePath);
    return sqliteEntries.length > 0 || hasLegacyStore
      ? [
          {
            ...target,
            sqliteEntries,
            hasLegacyStore,
            authProfileIdMap: resolveVerifiedSessionAuthProfileIdMap({
              agentId: target.agentId,
              cfg: params.cfg,
              env,
              authProfileIdMap: params.authProfileIdMap,
            }),
          },
        ]
      : [];
  });
  if (targets.length === 0) {
    return emptyRepairSummary();
  }
  if (!params.shouldRepair) {
    const stale = targets.flatMap((target) => {
      const sqliteStore = Object.fromEntries(
        target.sqliteEntries.map(({ sessionKey, entry }) => [sessionKey, entry]),
      );
      const sessionKeys = new Set(
        scanCodexSessionStoreRoutes(
          sqliteStore,
          params.blockedModelIdentities,
          target.authProfileIdMap,
        ),
      );
      if (target.hasLegacyStore) {
        for (const sessionKey of scanCodexSessionStoreRoutes(
          loadLegacySessionStore(target.storePath),
          params.blockedModelIdentities,
          target.authProfileIdMap,
        )) {
          sessionKeys.add(sessionKey);
        }
      }
      return Array.from(sessionKeys, (sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings:
        stale.length > 0
          ? [
              [
                "- Legacy `codex/*` or `openai-codex/*` session route state detected.",
                `- Affected sessions: ${stale.length}.`,
                "- Run `openclaw doctor --fix` to rewrite stale session model/provider pins across all agent session stores.",
              ].join("\n"),
            ]
          : [],
      changes: [],
    };
  }
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const repairedSessionKeys = new Set<string>();
    const sqliteStore = Object.fromEntries(
      target.sqliteEntries.map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
    const staleSqliteSessionKeys = scanCodexSessionStoreRoutes(
      sqliteStore,
      params.blockedModelIdentities,
      target.authProfileIdMap,
    );
    if (staleSqliteSessionKeys.length > 0) {
      const result = await applySessionEntryReplacements({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKeys: staleSqliteSessionKeys,
        skipMaintenance: true,
        update: (entries) => {
          const store = Object.fromEntries(
            entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
          );
          const repair = repairCodexSessionStoreRoutes({
            store,
            blockedModelIdentities: params.blockedModelIdentities,
            authProfileIdMap: target.authProfileIdMap,
          });
          return {
            result: repair,
            replacements: repair.sessionKeys.map((sessionKey) => ({
              sessionKey,
              entry: store[sessionKey]!,
            })),
          };
        },
      });
      for (const sessionKey of result.sessionKeys) {
        repairedSessionKeys.add(sessionKey);
      }
    }

    if (target.hasLegacyStore) {
      const staleLegacySessionKeys = scanCodexSessionStoreRoutes(
        loadLegacySessionStore(target.storePath),
        params.blockedModelIdentities,
        target.authProfileIdMap,
      );
      if (staleLegacySessionKeys.length > 0) {
        const result = await updateLegacySessionStore(
          target.storePath,
          (store) =>
            repairCodexSessionStoreRoutes({
              store,
              blockedModelIdentities: params.blockedModelIdentities,
              authProfileIdMap: target.authProfileIdMap,
            }),
          { skipMaintenance: true },
        );
        for (const sessionKey of result.sessionKeys) {
          repairedSessionKeys.add(sessionKey);
        }
      }
    }
    if (repairedSessionKeys.size > 0) {
      repairedStores += 1;
      repairedSessions += repairedSessionKeys.size;
    }
  }
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings: [],
    changes:
      repairedSessions > 0
        ? [
            `Repaired Codex session routes: moved ${repairedSessions} session${
              repairedSessions === 1 ? "" : "s"
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} to openai/* while preserving auth-profile pins.`,
          ]
        : [],
  };
}

function emptyRepairSummary(): CodexSessionRouteRepairSummary {
  return {
    scannedStores: 0,
    repairedStores: 0,
    repairedSessions: 0,
    warnings: [],
    changes: [],
  };
}
