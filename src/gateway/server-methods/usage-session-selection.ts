import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExistingUsageSessionFile } from "../../infra/session-cost-usage.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  loadGatewaySessionEntryReadOnly,
} from "../session-utils.js";
import {
  discoverAllSessionsForUsage,
  type UsageSessionSummaryTarget,
} from "./usage-session-loading.js";

export class UsageSessionInvalidRequestError extends Error {}

type ResolvedSessionUsageTarget = {
  entry: SessionEntry | undefined;
  agentId: string;
  sessionId: string;
  sessionFile: string;
};

export function resolveSessionUsageTarget(
  key: string,
  config: OpenClawConfig,
  agentIdHint?: string,
): ResolvedSessionUsageTarget | undefined {
  const { canonicalKey, entry, storePath } = loadGatewaySessionEntryReadOnly(
    key,
    agentIdHint ? { agentId: agentIdHint } : undefined,
  );
  const parsed = parseAgentSessionKey(key);
  const agentId =
    parsed?.agentId ?? agentIdHint ?? resolveSessionAgentId({ config, sessionKey: key });
  const sessionId = entry?.sessionId ?? parsed?.rest ?? key;
  const sessionFile = entry
    ? resolveExistingUsageSessionFile({
        agentId,
        sessionId,
        sessionTarget: {
          agentId,
          sessionId,
          sessionKey: canonicalKey,
          storePath,
        },
      })
    : resolveExistingUsageSessionFile({
        agentId,
        sessionId,
        sessionFile: resolveSessionFilePathCore(
          sessionId,
          undefined,
          resolveSessionFilePathOptions({ storePath, agentId }),
        ),
      });
  return sessionFile ? { entry, agentId, sessionId, sessionFile } : undefined;
}

export type UsageGroupingMode = "instance" | "family";

export type UsageSessionSelection = UsageSessionSummaryTarget & {
  key: string;
  label?: string;
  updatedAt: number;
  storeEntry?: SessionEntry;
  scope?: "instance" | "family";
  sessionFamilyKey?: string;
  currentSessionId?: string;
  includedSessionIds?: string[];
};

function usageSessionIdentity(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

type StoredUsageSession = { key: string; entry: SessionEntry };

function buildStoreBySessionIdentity(
  store: Record<string, SessionEntry>,
  agentIdBySessionKey: ReadonlyMap<string, string>,
) {
  const matchesByIdentity = new Map<string, Array<[string, SessionEntry]>>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const agentId = expectDefined(agentIdBySessionKey.get(key), "stored session owner");
    const identity = usageSessionIdentity(agentId, entry.sessionId);
    const matches = matchesByIdentity.get(identity) ?? [];
    matches.push([key, entry]);
    matchesByIdentity.set(identity, matches);
  }

  const storeByIdentity = new Map<string, StoredUsageSession>();
  for (const [identity, matches] of matchesByIdentity) {
    // Aliases within one agent share a transcript; another agent's identical id does not.
    const sessionId = expectDefined(matches[0], "stored session match")[1].sessionId;
    const preferredKey = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
    if (!preferredKey) {
      continue;
    }
    const preferredEntry = store[preferredKey];
    if (preferredEntry) {
      storeByIdentity.set(identity, { key: preferredKey, entry: preferredEntry });
    }
  }
  const familyMatches = new Map<
    string,
    { sessionId: string; matches: Array<[string, SessionEntry]> }
  >();
  for (const { key, entry } of storeByIdentity.values()) {
    const agentId = expectDefined(agentIdBySessionKey.get(key), "stored session owner");
    for (const sessionId of entry.usageFamilySessionIds ?? []) {
      const identity = usageSessionIdentity(agentId, sessionId);
      if (!storeByIdentity.has(identity)) {
        const candidates = familyMatches.get(identity) ?? { sessionId, matches: [] };
        candidates.matches.push([key, entry]);
        familyMatches.set(identity, candidates);
      }
    }
  }
  // Direct current owners beat recorded history (for example cron continuation
  // aliases). Ambiguous history stays an instance rather than being counted twice.
  const familyOwners = new Map(storeByIdentity);
  for (const [identity, { sessionId, matches }] of familyMatches) {
    const key = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
    if (key) {
      familyOwners.set(identity, { key, entry: expectDefined(store[key], "family owner") });
    }
  }
  return { storeByIdentity, familyOwners };
}

function withUsageGrouping(
  base: Omit<UsageSessionSelection, "instances">,
  groupingMode: UsageGroupingMode,
  familyOwners: ReadonlyMap<string, StoredUsageSession>,
  discoveredByIdentity: ReadonlyMap<string, { sessionId: string; sessionFile: string }>,
): UsageSessionSelection {
  const currentInstance = { sessionId: base.sessionId, sessionFile: base.sessionFile };
  if (groupingMode !== "family") {
    return { ...base, instances: [currentInstance] };
  }
  // Historical ids belong to this agent; identical ids owned by other agents stay separate.
  const includedSessionIds = [
    ...new Set(
      [base.sessionId, ...(base.storeEntry?.usageFamilySessionIds ?? [])]
        .map(normalizeOptionalString)
        .filter((id): id is string => Boolean(id)),
    ),
  ].filter(
    (id) =>
      id === base.sessionId ||
      familyOwners.get(usageSessionIdentity(base.agentId, id))?.entry.sessionId === base.sessionId,
  );
  return {
    ...base,
    // Discovery owns SQLite/archive precedence; loading must not guess storage
    // from the current instance, because one family can span both sources.
    instances: includedSessionIds.flatMap((id) => {
      const instance =
        id === base.sessionId
          ? currentInstance
          : discoveredByIdentity.get(usageSessionIdentity(base.agentId, id));
      return instance ? [instance] : [];
    }),
    scope: "family",
    sessionFamilyKey: base.storeEntry?.usageFamilyKey ?? base.key,
    currentSessionId: base.sessionId,
    includedSessionIds,
  };
}

export async function selectUsageSessions(params: {
  config: OpenClawConfig;
  agentId?: string;
  specificKey: string | null;
  groupingMode: UsageGroupingMode;
  startMs: number;
  endMs: number;
  visibilityFilter?: (key: string, entry: SessionEntry) => boolean;
}): Promise<UsageSessionSelection[]> {
  const {
    config,
    agentId: effectiveAgentId,
    specificKey,
    groupingMode,
    startMs,
    endMs,
    visibilityFilter,
  } = params;
  // Load session store for named sessions only on a result-cache miss.
  const sessionStoreOpts = effectiveAgentId ? { agentId: effectiveAgentId } : {};
  const { store, agentIdBySessionKey } = loadCombinedSessionStoreForGatewayCore(
    config,
    sessionStoreOpts,
  );
  const scopedStore = Object.fromEntries(
    Object.entries(store).filter(
      ([key, entry]) =>
        (!effectiveAgentId || agentIdBySessionKey.get(key) === effectiveAgentId) &&
        (!visibilityFilter || visibilityFilter(key, entry)),
    ),
  );
  const { storeByIdentity: storeBySessionIdentity, familyOwners } = buildStoreBySessionIdentity(
    scopedStore,
    agentIdBySessionKey,
  );
  // Only an individual instance can skip discovery. Families need the actual
  // historical sources, including retained JSONL artifacts beside SQLite windows.
  const discoveredSessions =
    !specificKey || groupingMode === "family"
      ? await discoverAllSessionsForUsage({
          config,
          ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
          startMs,
          endMs,
        })
      : [];
  const discoveredByIdentity = new Map(
    discoveredSessions.map((session) => [
      usageSessionIdentity(session.agentId, session.sessionId),
      session,
    ]),
  );
  const now = Date.now();

  const mergedEntries: UsageSessionSelection[] = [];

  if (specificKey) {
    const scopedSpecificKey = resolveStoredSessionKeyForAgentStore({
      cfg: config,
      agentId: expectDefined(effectiveAgentId, "specific session owner"),
      sessionKey: specificKey,
    });
    const scopedParsed = parseAgentSessionKey(scopedSpecificKey);
    const agentIdFromKey =
      scopedParsed?.agentId ?? expectDefined(effectiveAgentId, "specific session owner");
    const keyRest = scopedParsed?.rest ?? specificKey;

    // Prefer the store entry when available, even if the caller provides a discovered key
    // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
    const storeMatch = scopedStore[scopedSpecificKey]
      ? { key: scopedSpecificKey, entry: scopedStore[scopedSpecificKey] }
      : scopedStore[specificKey]
        ? { key: specificKey, entry: scopedStore[specificKey] }
        : null;
    const storeByIdMatch =
      storeBySessionIdentity.get(usageSessionIdentity(agentIdFromKey, keyRest)) ??
      (keyRest !== specificKey
        ? storeBySessionIdentity.get(usageSessionIdentity(agentIdFromKey, specificKey))
        : undefined) ??
      null;
    const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? scopedSpecificKey;
    const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
    if (visibilityFilter && !storeEntry) {
      throw new UsageSessionInvalidRequestError(`Invalid session reference: ${specificKey}`);
    }
    const sessionId = storeEntry?.sessionId ?? keyRest;

    // Stored sessions are canonical SQLite targets. JSONL discovery remains only for
    // sessions without a store row, so retired locators cannot redirect live state.
    let resolved: ResolvedSessionUsageTarget | undefined;
    try {
      resolved = resolveSessionUsageTarget(resolvedStoreKey, config, agentIdFromKey);
      if (!resolved || resolved.agentId !== agentIdFromKey || resolved.sessionId !== sessionId) {
        throw new Error("session target mismatch");
      }
    } catch {
      throw new UsageSessionInvalidRequestError(`Invalid session reference: ${specificKey}`);
    }
    const { sessionFile } = resolved;

    let updatedAt: number | undefined;
    if (parseSqliteSessionFileMarker(sessionFile)) {
      updatedAt = storeEntry?.updatedAt ?? now;
    } else {
      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile()) {
          updatedAt = storeEntry?.updatedAt ?? stats.mtimeMs;
        }
      } catch {
        // File doesn't exist - no results for this key
      }
    }
    if (updatedAt !== undefined) {
      mergedEntries.push(
        withUsageGrouping(
          {
            key: resolvedStoreKey,
            agentId: agentIdFromKey,
            sessionId,
            sessionFile,
            label: storeEntry?.label,
            updatedAt,
            storeEntry,
          },
          groupingMode,
          familyOwners,
          discoveredByIdentity,
        ),
      );
    }
  } else {
    const selectedFamilies = new Set<string>();
    for (const discovered of discoveredSessions) {
      const identity = usageSessionIdentity(discovered.agentId, discovered.sessionId);
      const owner = (groupingMode === "family" ? familyOwners : storeBySessionIdentity).get(
        identity,
      );
      if (!owner) {
        if (!visibilityFilter) {
          mergedEntries.push({
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            agentId: discovered.agentId,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            instances: [discovered],
            updatedAt: discovered.mtime,
            scope: "instance",
          });
        }
        continue;
      }
      const { key, entry } = owner;
      const familyIdentity = usageSessionIdentity(discovered.agentId, key);
      if (selectedFamilies.has(familyIdentity)) {
        continue;
      }
      // Rotation can leave the current window empty. A discovered historical
      // member still selects its recorded owner, once per canonical family row.
      let sessionFile = discoveredByIdentity.get(
        usageSessionIdentity(discovered.agentId, entry.sessionId),
      )?.sessionFile;
      if (!sessionFile) {
        const target = resolveSessionUsageTarget(key, config, discovered.agentId);
        if (
          !target ||
          target.agentId !== discovered.agentId ||
          target.sessionId !== entry.sessionId
        ) {
          throw new UsageSessionInvalidRequestError(`Invalid session reference: ${key}`);
        }
        sessionFile = target.sessionFile;
      }
      mergedEntries.push(
        withUsageGrouping(
          {
            key,
            agentId: discovered.agentId,
            sessionId: entry.sessionId,
            sessionFile,
            label: entry.label,
            updatedAt: entry.updatedAt ?? discovered.mtime,
            storeEntry: entry,
          },
          groupingMode,
          familyOwners,
          discoveredByIdentity,
        ),
      );
      if (groupingMode === "family") {
        selectedFamilies.add(familyIdentity);
      }
    }
  }

  // Sort by most recent first
  mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

  return mergedEntries;
}
