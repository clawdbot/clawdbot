// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/label selectors into one canonical session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import { shouldKeepStoreOnlyChildLink } from "./session-utils-core.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveSessionListLineageSqlQuery,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

export type SessionsResolveResult =
  | { ok: true; key: string }
  | { ok: true; missing: true }
  | { ok: false; error: ErrorShape };

function noSessionFoundResult(params: { p: SessionsResolveParams; message: string }) {
  if (params.p.allowMissing) {
    return { ok: true, missing: true } as const;
  }
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, params.message),
  } as const;
}

/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, entry, options);
  if (deletedAgentId === null) {
    return null;
  }
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  };
}

function isResolvedSessionKeyVisible(params: {
  canonicalKey?: string;
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
  store: Record<string, SessionEntry>;
  key: string;
}) {
  const entry = params.store[params.key];
  if (!entry) {
    return false;
  }
  const effectiveKey = params.canonicalKey ?? params.key;
  const specialKey = effectiveKey === "global" || effectiveKey === "unknown";
  if (effectiveKey === "global" && params.p.includeGlobal !== true) {
    return false;
  }
  if (effectiveKey === "unknown" && (params.p.agentId || params.p.includeUnknown !== true)) {
    return false;
  }
  const parsed = parseAgentSessionKey(effectiveKey);
  if (
    !specialKey &&
    params.p.agentId &&
    (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.p.agentId))
  ) {
    return false;
  }
  if (
    parsed?.rest === "sessions" &&
    !normalizeOptionalString(entry.sessionId) &&
    entry.updatedAt == null
  ) {
    return false;
  }
  if (isCronRunSessionKey(effectiveKey)) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.p.spawnedBy);
  if (!spawnedBy) {
    return true;
  }
  if (specialKey) {
    return false;
  }
  if (entry.archivedAt !== undefined) {
    return false;
  }
  const lineage = resolveSessionListLineageSqlQuery(spawnedBy, Date.now());
  if (lineage.includeLineageSessionKeys?.includes(params.key)) {
    return true;
  }
  if (lineage.excludeLineageSessionKeys?.includes(params.key)) {
    return false;
  }
  return (
    shouldKeepStoreOnlyChildLink(entry, Date.now()) &&
    (entry?.spawnedBy === spawnedBy || entry?.parentSessionKey === spawnedBy)
  );
}

function assertCanonicalResolveMatches(
  cfg: OpenClawConfig,
  matches: readonly [string, SessionEntry][],
): void {
  const canonicalKeys = new Set<string>();
  for (const [sessionKey, entry] of matches) {
    if (resolveDeletedAgentIdFromSessionKey(cfg, sessionKey, entry) !== null) {
      continue;
    }
    const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
    if (canonicalKey !== sessionKey || canonicalKeys.has(canonicalKey)) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${canonicalKey}`,
      );
    }
    canonicalKeys.add(canonicalKey);
  }
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, p } = params;

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasLabel].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, or label (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required"),
    };
  }

  if (hasKey) {
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key,
      clone: false,
      // Hidden rows must stay indistinguishable from missing rows; surface the
      // canonical repair diagnostic only after the requested row is visible.
      deferCanonicalValidation: true,
    });
    const store = target.store;
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      if (target.canonicalValidationError) {
        throw target.canonicalValidationError;
      }
      const legacyKey = target.storeKeys.find(
        (candidate) => candidate !== target.canonicalKey && store[candidate],
      );
      if (legacyKey) {
        // The canonical row is visible, so any coexisting alias is a session-integrity
        // failure even when the alias carries different lineage metadata.
        throw canonicalSessionKeyMigrationRequiredError(
          `duplicate rows resolve to canonical session key ${target.canonicalKey}`,
        );
      }
      return (
        validateSessionAgentExists(cfg, target.canonicalKey, store[target.canonicalKey], {
          acpMetadataSessionKey: target.canonicalKey,
        }) ?? { ok: true, key: target.canonicalKey }
      );
    }
    const legacyKey = target.storeKeys.find(
      (candidate) => candidate !== target.canonicalKey && store[candidate],
    );
    if (legacyKey) {
      if (
        !isResolvedSessionKeyVisible({
          canonicalKey: target.canonicalKey,
          cfg,
          p,
          store,
          key: legacyKey,
        })
      ) {
        // With no canonical row, a hidden alias must not reveal that repair state exists.
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      if (target.canonicalValidationError) {
        throw target.canonicalValidationError;
      }
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${target.canonicalKey}`,
      );
    }
    if (!store[target.canonicalKey]) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    return noSessionFoundResult({ p, message: `No session found: ${key}` });
  }

  if (hasSessionId) {
    // sessionId can collide across stores; delegate selection so exact key
    // matches and ambiguity rules stay shared with other session-id callers.
    const lineageQuery = resolveSessionListLineageSqlQuery(p.spawnedBy, Date.now());
    const spawnedBy = normalizeOptionalString(p.spawnedBy);
    const lineageSqlQuery =
      (lineageQuery.excludeLineageSessionKeys?.length ?? 0) > 400
        ? { selectionResidual: true as const }
        : { ...lineageQuery, ...(spawnedBy ? { spawnedBy } : {}) };
    const { store } = loadCombinedSessionStoreForGateway(cfg, {
      agentId: p.agentId,
      projection: "list",
      query: {
        archived: false,
        includeGlobal: p.includeGlobal === true,
        includeUnknown: !p.agentId && p.includeUnknown === true,
        ...lineageSqlQuery,
        // The SQLite selector matches current_session_id OR exact session_key.
        sessionId,
      },
    });
    const matches = Object.entries(store).filter(
      ([matchKey, entry]) =>
        (entry.sessionId === sessionId || matchKey === sessionId) &&
        isResolvedSessionKeyVisible({
          canonicalKey: resolveSessionStoreKey({
            cfg,
            sessionKey: matchKey,
            ...(p.agentId ? { storeAgentId: p.agentId } : {}),
          }),
          cfg,
          key: matchKey,
          p,
          store,
        }),
    );
    assertCanonicalResolveMatches(cfg, matches);
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
    }
    if (selection.kind === "ambiguous") {
      const keys = selection.sessionKeys.join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
      };
    }
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    return (
      validateSessionAgentExists(cfg, selection.sessionKey, selectedEntry) ?? {
        ok: true,
        key: selection.sessionKey,
      }
    );
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
  }

  const labelLineageQuery = resolveSessionListLineageSqlQuery(p.spawnedBy, Date.now());
  const labelSpawnedBy = normalizeOptionalString(p.spawnedBy);
  const labelLineageSqlQuery =
    (labelLineageQuery.excludeLineageSessionKeys?.length ?? 0) > 400
      ? { selectionResidual: true as const }
      : { ...labelLineageQuery, ...(labelSpawnedBy ? { spawnedBy: labelSpawnedBy } : {}) };
  const { store } = loadCombinedSessionStoreForGateway(cfg, {
    agentId: p.agentId,
    projection: "list",
    query: {
      archived: false,
      includeGlobal: p.includeGlobal === true,
      includeUnknown: !p.agentId && p.includeUnknown === true,
      label: parsedLabel.label,
      ...labelLineageSqlQuery,
    },
  });
  const matches = Object.entries(store).filter(
    ([matchKey, entry]) =>
      entry.label === parsedLabel.label &&
      isResolvedSessionKeyVisible({
        canonicalKey: resolveSessionStoreKey({
          cfg,
          sessionKey: matchKey,
          ...(p.agentId ? { storeAgentId: p.agentId } : {}),
        }),
        cfg,
        key: matchKey,
        p,
        store,
      }),
  );
  assertCanonicalResolveMatches(cfg, matches);
  if (matches.length === 0) {
    return noSessionFoundResult({
      p,
      message: `No session found with label: ${parsedLabel.label}`,
    });
  }
  if (matches.length > 1) {
    const keys = matches.map(([matchKey]) => matchKey).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
    };
  }

  const [labelKey, labelEntry] = matches[0] as [string, SessionEntry];
  return validateSessionAgentExists(cfg, labelKey, labelEntry) ?? { ok: true, key: labelKey };
}
