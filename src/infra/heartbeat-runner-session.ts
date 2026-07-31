import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveMainScopedEventSessionKey } from "./event-session-routing.js";
import type { HeartbeatConfig } from "./heartbeat-runner-config.js";

export function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId?: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storePath = resolveStorePath(sessionCfg?.store, {
    // A literal `global` row is global only inside the selected agent's store.
    // Falling back here leaks the default agent's route into secondary heartbeats.
    agentId: resolvedAgentId,
    env,
  });
  const mainEntry = loadSessionEntry({ storePath, sessionKey: mainSessionKey, env });

  if (scope === "global") {
    return {
      sessionKey: mainSessionKey,
      storePath,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      entry: mainEntry,
      suppressOriginatingContext: true,
    };
  }

  if (forced && !isSubagentSessionKey(forced)) {
    const forcedCandidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey: forced,
      mainKey: cfg.session?.mainKey,
    });
    if (!isSubagentSessionKey(forcedCandidate)) {
      const forcedCanonical = canonicalizeMainSessionAlias({
        cfg,
        agentId: resolvedAgentId,
        sessionKey: forcedCandidate,
      });
      if (forcedCanonical !== "global" && !isSubagentSessionKey(forcedCanonical)) {
        const sessionAgentId = resolveAgentIdFromSessionKey(forcedCanonical);
        if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
          const routedSessionKey =
            resolveMainScopedEventSessionKey({
              cfg,
              sessionKey: forcedCanonical,
              agentId: resolvedAgentId,
            }) ?? forcedCanonical;
          return {
            sessionKey: routedSessionKey,
            storePath,
            entry: loadSessionEntry({ storePath, sessionKey: routedSessionKey, env }),
            suppressOriginatingContext: false,
          };
        }
      }
    }
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return {
      sessionKey: mainSessionKey,
      storePath,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  if (isSubagentSessionKey(candidate)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }
  const canonical = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolvedAgentId,
    sessionKey: candidate,
  });
  if (canonical !== "global" && !isSubagentSessionKey(canonical)) {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        sessionKey: canonical,
        storePath,
        entry: loadSessionEntry({ storePath, sessionKey: canonical, env }),
        suppressOriginatingContext: false,
      };
    }
  }

  return {
    sessionKey: mainSessionKey,
    storePath,
    entry: mainEntry,
    suppressOriginatingContext: false,
  };
}

export function resolveIsolatedHeartbeatSessionKey(params: {
  agentId: string;
  sessionKey: string;
  configuredSessionKey: string;
  sessionEntry?: { heartbeatIsolatedBaseSessionKey?: string };
}) {
  const storedBaseSessionKey = params.sessionEntry?.heartbeatIsolatedBaseSessionKey?.trim();
  if (params.configuredSessionKey === "global") {
    // The base global row stays literal inside its agent store; its isolated sibling
    // must be agent-qualified so ordinary session writes remain canonical.
    const isolatedSessionKey = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: "global:heartbeat",
    });
    const suffix = params.sessionKey.slice(isolatedSessionKey.length);
    if (
      params.sessionKey === "global" ||
      (storedBaseSessionKey === "global" &&
        (params.sessionKey === isolatedSessionKey ||
          (params.sessionKey.startsWith(isolatedSessionKey) && /^(:heartbeat)+$/.test(suffix))))
    ) {
      return { isolatedSessionKey, isolatedBaseSessionKey: "global" };
    }
  }
  if (storedBaseSessionKey) {
    const suffix = params.sessionKey.slice(storedBaseSessionKey.length);
    if (
      params.sessionKey.startsWith(storedBaseSessionKey) &&
      suffix.length > 0 &&
      /^(:heartbeat)+$/.test(suffix)
    ) {
      return {
        isolatedSessionKey: `${storedBaseSessionKey}:heartbeat`,
        isolatedBaseSessionKey: storedBaseSessionKey,
      };
    }
  }

  // Collapse repeated `:heartbeat` suffixes introduced by wake-triggered re-entry.
  // The guard on configuredSessionKey ensures we do not strip a legitimate single
  // `:heartbeat` suffix that is part of the user-configured base key itself
  // (e.g. heartbeat.session: "alerts:heartbeat"). When the configured key already
  // ends with `:heartbeat`, a forced wake passes `configuredKey:heartbeat` which
  // must be treated as a new base rather than an existing isolated key.
  const configuredSuffix = params.sessionKey.slice(params.configuredSessionKey.length);
  if (
    params.sessionKey.startsWith(params.configuredSessionKey) &&
    /^(:heartbeat)+$/.test(configuredSuffix) &&
    !params.configuredSessionKey.endsWith(":heartbeat")
  ) {
    return {
      isolatedSessionKey: `${params.configuredSessionKey}:heartbeat`,
      isolatedBaseSessionKey: params.configuredSessionKey,
    };
  }
  return {
    isolatedSessionKey: `${params.sessionKey}:heartbeat`,
    isolatedBaseSessionKey: params.sessionKey,
  };
}

export function resolveStaleHeartbeatIsolatedSessionKey(params: {
  sessionKey: string;
  isolatedSessionKey: string;
  isolatedBaseSessionKey: string;
}) {
  if (params.sessionKey === params.isolatedSessionKey) {
    return undefined;
  }
  const suffix = params.sessionKey.slice(params.isolatedBaseSessionKey.length);
  if (
    params.sessionKey.startsWith(params.isolatedBaseSessionKey) &&
    suffix.length > 0 &&
    /^(:heartbeat)+$/.test(suffix)
  ) {
    return params.sessionKey;
  }
  return undefined;
}

export async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const entry = loadSessionEntry({ storePath, sessionKey });
  if (!entry) {
    return;
  }
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) {
    return;
  }
  await patchSessionEntry(
    { storePath, sessionKey },
    (nextEntry, context) => {
      if (!context.existingEntry) {
        return null;
      }
      const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
      if (nextEntry.updatedAt === resolvedUpdatedAt) {
        return null;
      }
      return { ...nextEntry, updatedAt: resolvedUpdatedAt };
    },
    { replaceEntry: true },
  );
}
