import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveMainScopedEventSessionKey } from "./event-session-routing.js";
import type { HeartbeatConfig } from "./heartbeat-runner-config.js";

export function resolveHeartbeatSessionKey(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId);
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    // A literal `global` row is global only inside the selected agent's store.
    // Falling back here leaks the default agent's route into secondary heartbeats.
    agentId: resolvedAgentId,
    env,
  });
  const mainSession = (suppressOriginatingContext = false) => ({
    sessionKey: mainSessionKey,
    storePath,
    suppressOriginatingContext,
  });

  if (scope === "global") {
    return mainSession();
  }

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return mainSession(true);
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
            suppressOriginatingContext: false,
          };
        }
      }
    }
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return mainSession();
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return mainSession();
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  if (isSubagentSessionKey(candidate)) {
    return mainSession();
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
        suppressOriginatingContext: false,
      };
    }
  }

  return mainSession();
}

export function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const resolved = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, forcedSessionKey, env);
  return {
    ...resolved,
    entry: loadSessionEntry({
      storePath: resolved.storePath,
      sessionKey: resolved.sessionKey,
      env,
    }),
  };
}

function resolveIsolatedHeartbeatSessionKey(params: {
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

/** Selects the event queue, execution key and descriptive conversation before delivery. */
export function resolveHeartbeatSessionSelection(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const session = resolveHeartbeatSession(cfg, agentId, heartbeat, forcedSessionKey, env);
  if (heartbeat?.isolatedSession !== true) {
    return {
      ...session,
      run: { kind: "shared", sessionKey: session.sessionKey },
      conversationEntry: session.entry,
      inspectsRunQueue: true,
    } as const;
  }
  const configured = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, undefined, env);
  const { isolatedSessionKey, isolatedBaseSessionKey } = resolveIsolatedHeartbeatSessionKey({
    agentId,
    sessionKey: session.sessionKey,
    configuredSessionKey: configured.sessionKey,
    sessionEntry: session.entry,
  });
  return {
    ...session,
    run: {
      kind: "isolated",
      sessionKey: isolatedSessionKey,
      baseSessionKey: isolatedBaseSessionKey,
    },
    conversationEntry:
      isolatedBaseSessionKey === session.sessionKey
        ? session.entry
        : loadSessionEntry({
            storePath: session.storePath,
            sessionKey: isolatedBaseSessionKey,
            env,
          }),
    // Legacy isolated queues retain their route after the execution key is canonicalized.
    inspectsRunQueue: session.sessionKey !== isolatedBaseSessionKey,
  } as const;
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
  await patchSessionEntryCore(
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
