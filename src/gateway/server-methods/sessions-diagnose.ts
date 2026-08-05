// Read-only session diagnosis for stuck or ambiguous session state.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDiagnoseParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getEmbeddedRunDiagnosticSnapshot } from "../../agents/embedded-agent-runner/run-state.js";
import type { SessionEntry } from "../../config/sessions.js";
import { listSessionEntries } from "../../config/sessions/session-accessor.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
} from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { getDiagnosticSessionStateSnapshot } from "../../logging/diagnostic-session-state.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";
import { collectTrackedActiveSessionRunSnapshot } from "./session-active-runs.js";
import { buildDiagnoseResult } from "./sessions-diagnose-result.js";
import {
  buildDiagnoseRow,
  buildNotFoundDiagnosis,
  countDiagnoseSelectors,
  DEFAULT_DIAGNOSE_SCAN_LIMIT,
  getDiagnoseLaneSnapshot,
  isDiagnoseRowTerminal,
  isDiagnoseSharedRuntimeEvidenceUnambiguous,
  STALE_PROGRESS_MIN_AGE_MS,
  type DiagnoseCandidate,
  type DiagnoseParams,
  type DiagnoseRow,
  type DiagnoseTarget,
} from "./sessions-diagnose-shared.js";
import { loadSessionEntriesForTarget } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type RequestedDiagnoseAgentIdResolution =
  | { ok: true; agentId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> };

function resolveRequestedDiagnoseAgentId(
  cfg: OpenClawConfig,
  key: string,
  explicitAgentId?: string,
  options?: { allowUnknownAgentId?: boolean },
): RequestedDiagnoseAgentIdResolution {
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
  const parsed = parseAgentSessionKey(key);
  const requestedAgentId = normalizeOptionalString(explicitAgentId);
  const isAgentScopedUnscopedKey =
    canonicalKey === "global" ||
    (canonicalKey === "unknown" && options?.allowUnknownAgentId === true);
  if (requestedAgentId) {
    const agentId = normalizeAgentId(requestedAgentId);
    if (!listAgentIds(cfg).includes(agentId)) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
      };
    }
    if (parsed?.agentId && normalizeAgentId(parsed.agentId) !== agentId) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      };
    }
    if (!isAgentScopedUnscopedKey) {
      const keyAgentId = parsed?.agentId
        ? normalizeAgentId(parsed.agentId)
        : normalizeAgentId(resolveSessionStoreAgentId(cfg, canonicalKey));
      if (keyAgentId !== agentId) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
        };
      }
    }
    return { ok: true, agentId };
  }
  if (!parsed?.agentId) {
    return { ok: true };
  }
  const inferredAgentId = normalizeAgentId(parsed.agentId);
  if (isAgentScopedUnscopedKey && !listAgentIds(cfg).includes(inferredAgentId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${parsed.agentId}"`),
    };
  }
  return {
    ok: true,
    agentId: isAgentScopedUnscopedKey ? inferredAgentId : undefined,
  };
}

function scoreDiagnoseCandidatePreselect(params: {
  key: string;
  entry: SessionEntry;
  context: GatewayRequestContext;
  agentId?: string;
  defaultAgentId: string;
  configuredAgentCount: number;
}): number {
  const gatewayRun = collectTrackedActiveSessionRunSnapshot({
    context: params.context,
    requestedKey: params.key,
    canonicalKey: params.key,
    sessionId: params.entry.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    defaultAgentId: params.defaultAgentId,
    scopeUnknownByAgent: true,
    requireFallbackAgentOwnership: params.configuredAgentCount > 1,
  });
  const embeddedRun = getEmbeddedRunDiagnosticSnapshot({
    sessionId: params.entry.sessionId,
    sessionKey: params.key,
    sessionFile: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const useSharedRuntimeEvidence = isDiagnoseSharedRuntimeEvidenceUnambiguous(
    params.key,
    params.configuredAgentCount,
  );
  const diagnostic = useSharedRuntimeEvidence
    ? getDiagnosticSessionStateSnapshot({
        sessionId: params.entry.sessionId,
        sessionKey: params.key,
        sessionFile: params.key,
      })
    : undefined;
  const activity = useSharedRuntimeEvidence
    ? getDiagnosticSessionActivitySnapshot({
        sessionId: params.entry.sessionId,
        sessionKey: params.key,
      })
    : undefined;
  const lane = useSharedRuntimeEvidence ? getDiagnoseLaneSnapshot(params.key) : undefined;
  const hasActiveEvidence =
    gatewayRun.hasActiveRun || embeddedRun.active || Boolean(activity?.activeWorkKind);
  const hasQueuedEvidence = (diagnostic?.queueDepth ?? 0) > 0 || (lane?.queuedCount ?? 0) > 0;
  const hasProcessingEvidence = diagnostic?.state === "processing";
  const hasCurrentWorkEvidence = hasActiveEvidence || hasQueuedEvidence || hasProcessingEvidence;
  const terminal = isDiagnoseRowTerminal(buildDiagnoseRow(params.key, params.entry));
  let score = 0;
  if (hasActiveEvidence) {
    score += 50;
  }
  if (hasQueuedEvidence) {
    score += 40;
  }
  if (hasProcessingEvidence) {
    score += 30;
  }
  if (terminal && (hasActiveEvidence || hasProcessingEvidence)) {
    score += 80;
  }
  if (
    hasCurrentWorkEvidence &&
    activity?.lastProgressAgeMs !== undefined &&
    activity.lastProgressAgeMs >= STALE_PROGRESS_MIN_AGE_MS
  ) {
    score += 20;
  }
  return score;
}

function buildDiagnoseCandidate(params: {
  cfg: OpenClawConfig;
  key: string;
  entry: SessionEntry;
  storePath: string;
  fallbackAgentId?: string;
}): DiagnoseCandidate {
  return {
    key: params.key,
    entry: params.entry,
    row: buildDiagnoseRow(params.key, params.entry),
    storePath: params.storePath,
    agentId:
      resolveStoredSessionOwnerAgentId({
        cfg: params.cfg,
        agentId: params.fallbackAgentId ?? resolveDefaultAgentId(params.cfg),
        sessionKey: params.key,
      }) ?? params.fallbackAgentId,
  };
}

function listExplicitDiagnoseCandidateRows(params: {
  cfg: OpenClawConfig;
  p: DiagnoseParams;
  entryFilter?: (sessionKey: string, entry: SessionEntry) => boolean;
}): DiagnoseCandidate[] {
  const { cfg, p, entryFilter } = params;
  const requestedAgentId = p.agentId ? normalizeAgentId(p.agentId) : undefined;
  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : resolveAllAgentSessionStoreTargetsSync(cfg);
  const candidates: DiagnoseCandidate[] = [];
  for (const target of targets) {
    for (const { sessionKey, entry } of listSessionEntries({
      clone: false,
      storePath: target.storePath,
    })) {
      if (!entry) {
        continue;
      }
      const key = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: target.agentId,
        sessionKey,
      });
      if (entryFilter?.(key, entry) === false) {
        continue;
      }
      if (p.label && entry.label !== p.label) {
        continue;
      }
      if (p.sessionId && entry.sessionId !== p.sessionId) {
        continue;
      }
      candidates.push(
        buildDiagnoseCandidate({
          cfg,
          key,
          entry,
          storePath: target.storePath,
          fallbackAgentId: target.agentId,
        }),
      );
    }
  }
  return candidates;
}

function listDiagnoseCandidateRows(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  p: DiagnoseParams;
  entryFilter?: (sessionKey: string, entry: SessionEntry) => boolean;
}) {
  const { cfg, context, p, entryFilter } = params;
  const hasExplicitNonKeySelector = Boolean(p.sessionId || p.label);
  const requestedAgentId = p.agentId ? normalizeAgentId(p.agentId) : undefined;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const configuredAgentCount = listAgentIds(cfg).length;
  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : resolveAllAgentSessionStoreTargetsSync(cfg);
  const candidates: Array<{ candidate: DiagnoseCandidate; preselectScore: number }> = [];
  for (const target of targets) {
    for (const { sessionKey, entry } of listSessionEntries({
      clone: false,
      storePath: target.storePath,
    })) {
      if (!entry) {
        continue;
      }
      const key = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: target.agentId,
        sessionKey,
      });
      if (entryFilter?.(key, entry) === false) {
        continue;
      }
      if (key === "global" && p.includeGlobal !== true && !hasExplicitNonKeySelector) {
        continue;
      }
      if (key === "unknown" && p.includeUnknown !== true && !hasExplicitNonKeySelector) {
        continue;
      }
      if (p.label && entry.label !== p.label) {
        continue;
      }
      if (p.sessionId && entry.sessionId !== p.sessionId) {
        continue;
      }
      const candidate = buildDiagnoseCandidate({
        cfg,
        key,
        entry,
        storePath: target.storePath,
        fallbackAgentId: target.agentId,
      });
      candidates.push({
        candidate,
        preselectScore: scoreDiagnoseCandidatePreselect({
          key,
          entry,
          context,
          agentId: candidate.agentId ?? target.agentId,
          defaultAgentId,
          configuredAgentCount,
        }),
      });
    }
  }
  const selectedCandidates = candidates
    .toSorted((a, b) => {
      const activePriority = b.preselectScore - a.preselectScore;
      return activePriority || (b.candidate.row.updatedAt ?? 0) - (a.candidate.row.updatedAt ?? 0);
    })
    .slice(0, DEFAULT_DIAGNOSE_SCAN_LIMIT)
    .map(({ candidate }) => candidate);
  return { candidates: selectedCandidates };
}

function scoreDiagnoseCandidate(params: {
  row: DiagnoseRow;
  context: GatewayRequestContext;
  cfg: OpenClawConfig;
  agentId?: string;
}): number {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const configuredAgentCount = listAgentIds(params.cfg).length;
  const gatewayRun = collectTrackedActiveSessionRunSnapshot({
    context: params.context,
    requestedKey: params.row.key,
    canonicalKey: params.row.key,
    sessionId: params.row.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    defaultAgentId,
    scopeUnknownByAgent: true,
    requireFallbackAgentOwnership: configuredAgentCount > 1,
  });
  const embeddedRun = getEmbeddedRunDiagnosticSnapshot({
    sessionId: params.row.sessionId,
    sessionKey: params.row.key,
    sessionFile: params.row.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const useSharedRuntimeEvidence = isDiagnoseSharedRuntimeEvidenceUnambiguous(
    params.row.key,
    configuredAgentCount,
  );
  const diagnostic = useSharedRuntimeEvidence
    ? getDiagnosticSessionStateSnapshot({
        sessionId: params.row.sessionId,
        sessionKey: params.row.key,
        sessionFile: params.row.key,
      })
    : undefined;
  const activity = useSharedRuntimeEvidence
    ? getDiagnosticSessionActivitySnapshot({
        sessionId: params.row.sessionId,
        sessionKey: params.row.key,
      })
    : undefined;
  const lane = useSharedRuntimeEvidence ? getDiagnoseLaneSnapshot(params.row.key) : undefined;
  const terminal = isDiagnoseRowTerminal(params.row);
  const hasActiveEvidence =
    gatewayRun.hasActiveRun || embeddedRun.active || Boolean(activity?.activeWorkKind);
  const hasQueuedEvidence = (diagnostic?.queueDepth ?? 0) > 0 || (lane?.queuedCount ?? 0) > 0;
  const hasProcessingEvidence = diagnostic?.state === "processing";
  const hasCurrentWorkEvidence = hasActiveEvidence || hasQueuedEvidence || hasProcessingEvidence;
  let score = 0;
  if (hasActiveEvidence) {
    score += 50;
  }
  if (hasQueuedEvidence) {
    score += 40;
  }
  if (hasProcessingEvidence) {
    score += 30;
  }
  if (terminal && (gatewayRun.hasActiveRun || embeddedRun.active || hasProcessingEvidence)) {
    score += 80;
  }
  if (
    hasCurrentWorkEvidence &&
    activity?.lastProgressAgeMs !== undefined &&
    activity.lastProgressAgeMs >= STALE_PROGRESS_MIN_AGE_MS
  ) {
    score += 20;
  }
  return score;
}

async function resolveDiagnoseTarget(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  p: DiagnoseParams;
  client: GatewayClient | null;
}): Promise<DiagnoseTarget | null> {
  const { cfg, context, p } = params;
  const entryFilter = createSessionListEntryFilter({ client: params.client });
  if (countDiagnoseSelectors(p) > 1) {
    throw new Error("choose only one of key, sessionId, or label for sessions.diagnose");
  }
  const requestedAgentId = p.key
    ? resolveRequestedDiagnoseAgentId(cfg, p.key, p.agentId, { allowUnknownAgentId: true })
    : resolveRequestedDiagnoseAgentId(cfg, "global", p.agentId);
  if (!requestedAgentId.ok) {
    throw new Error(requestedAgentId.error.message);
  }
  if (p.key) {
    const { target, storePath, entry } = loadSessionEntriesForTarget({
      key: p.key,
      cfg,
      ...(requestedAgentId.agentId ? { agentId: requestedAgentId.agentId } : {}),
    });
    if (!entry) {
      return null;
    }
    if (entryFilter?.(target.canonicalKey, entry) === false) {
      return null;
    }
    return {
      key: target.canonicalKey,
      chosenBecause: "explicit key selector",
      row: buildDiagnoseRow(target.canonicalKey, entry),
      entry,
      storePath,
      agentId: target.agentId ?? requestedAgentId.agentId,
    };
  }

  if (p.sessionId || p.label) {
    const candidates = listExplicitDiagnoseCandidateRows({ cfg, p, entryFilter });
    if (candidates.length > 1) {
      throw new Error(
        p.sessionId
          ? `multiple sessions match sessionId ${p.sessionId}; diagnose by session key instead`
          : `multiple sessions match label ${p.label}; diagnose by session key instead`,
      );
    }
    const candidate = candidates[0];
    return candidate
      ? {
          ...candidate,
          chosenBecause: p.sessionId ? "explicit session id selector" : "explicit label selector",
        }
      : null;
  }

  const listed = listDiagnoseCandidateRows({ cfg, context, p, entryFilter });
  const candidates = listed.candidates;
  if (candidates.length === 0) {
    return null;
  }
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreDiagnoseCandidate({
        row: candidate.row,
        context,
        cfg,
        agentId: candidate.agentId,
      }),
    }))
    .toSorted(
      (a, b) =>
        b.score - a.score || (b.candidate.row.updatedAt ?? 0) - (a.candidate.row.updatedAt ?? 0),
    );
  const selected = scored[0];
  if (!selected) {
    return null;
  }
  return {
    ...selected.candidate,
    chosenBecause:
      selected.score > 0 ? "highest live or contradictory evidence score" : "newest stored session",
  };
}

export const sessionDiagnoseHandlers: GatewayRequestHandlers = {
  "sessions.diagnose": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsDiagnoseParams, "sessions.diagnose", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    try {
      const target = await resolveDiagnoseTarget({ cfg, context, p, client });
      if (!target) {
        const hasExplicitSelector = Boolean(p.key || p.sessionId || p.label);
        respond(
          true,
          buildNotFoundDiagnosis(
            p,
            hasExplicitSelector ? "not_found" : "no_sessions",
            hasExplicitSelector
              ? "No stored session matched the requested selector."
              : "No stored sessions are available to diagnose.",
          ),
          undefined,
        );
        return;
      }
      respond(true, await buildDiagnoseResult({ cfg, context, p, target }), undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
};
