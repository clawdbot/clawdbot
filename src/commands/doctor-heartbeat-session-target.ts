import { listAgentEntries, listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import { resolveHeartbeatDeliveryTarget } from "../infra/outbound/targets.js";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  return listAgentEntries(cfg).some((entry) => Boolean(entry?.heartbeat));
}

function resolveHeartbeatConfig(cfg: OpenClawConfig, agentId: string): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

function listHeartbeatDoctorAgents(cfg: OpenClawConfig) {
  if (hasExplicitHeartbeatAgents(cfg)) {
    return listAgentEntries(cfg)
      .filter((entry) => entry?.heartbeat)
      .map((entry) => normalizeAgentId(entry.id))
      .filter((agentId) => agentId);
  }
  if (cfg.agents?.defaults?.heartbeat) {
    return listAgentIds(cfg);
  }
  return [];
}

/**
 * Detect heartbeat configs that pin a non-existent session. The runtime
 * resolves `heartbeat.session` to a sessionKey via `resolveHeartbeatSession`;
 * if the entry is missing, `resolveHeartbeatDeliveryTarget` falls back to
 * `{channel:"none", reason:"no-target"}` and the heartbeat fires a model
 * call whose reply has nowhere to land. Common cause: the configured Slack
 * channel ID does not match any channel the agent has ever joined (e.g.,
 * heartbeat pins channel `c0b2eddpw95` but the agent only has sessions in
 * `c0ag7jag35g`, or the agent has no Slack bot at all).
 *
 * Warning only — repair would mean rewriting the config, which is the
 * operator's intent to express.
 */
export function describeHeartbeatSessionTargetIssues(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  const sessionScope = cfg.session?.scope ?? "per-sender";
  for (const agentId of listHeartbeatDoctorAgents(cfg)) {
    if (!agentId) {
      continue;
    }
    const resolvedAgentId = normalizeAgentId(agentId);
    const heartbeatConfig = resolveHeartbeatConfig(cfg, resolvedAgentId);
    if (!heartbeatConfig) {
      continue;
    }
    if (!resolveHeartbeatIntervalMs(cfg, undefined, heartbeatConfig)) {
      continue;
    }
    const configuredSession = normalizeOptionalString(heartbeatConfig.session);
    if (!configuredSession) {
      continue;
    }
    const normalizedSession = configuredSession.toLowerCase();
    // `main` / `global` resolve to the agent main session via
    // `resolveHeartbeatSession`; missing entries fall back to the same key
    // and are repaired elsewhere — don't double-warn here.
    if (normalizedSession === "main" || normalizedSession === "global") {
      continue;
    }
    if (isSubagentSessionKey(configuredSession)) {
      continue;
    }
    if (sessionScope === "global") {
      continue;
    }
    const target = normalizeOptionalString(heartbeatConfig.target);
    if (!target || target === "none") {
      continue;
    }
    const deliveryWithoutSession = resolveHeartbeatDeliveryTarget({
      cfg,
      heartbeat: heartbeatConfig,
    });
    if (deliveryWithoutSession.channel !== "none" && deliveryWithoutSession.to) {
      continue;
    }
    const candidateSession = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey: configuredSession,
      mainKey: cfg.session?.mainKey,
    });
    if (isSubagentSessionKey(candidateSession)) {
      continue;
    }
    const canonicalSession = canonicalizeMainSessionAlias({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: candidateSession,
    });
    if (
      canonicalSession === "global" ||
      isSubagentSessionKey(canonicalSession) ||
      resolveAgentIdFromSessionKey(canonicalSession) !== resolvedAgentId
    ) {
      continue;
    }
    const storeAgentId = resolvedAgentId;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: storeAgentId });
    const store = loadSessionStore(storePath);
    const entry = store[canonicalSession];
    if (entry) {
      continue;
    }
    warnings.push(
      [
        `- Agent ${agentId} heartbeat.session pins ${configuredSession} (resolved to ${canonicalSession}) but that session has no entry in ${storePath}.`,
        `  Heartbeats will run but resolve delivery to channel="none"/reason="no-target", so replies are dropped silently.`,
        `  Fix: point heartbeat.session at a session the agent actually owns, set heartbeat.target="none" to suppress delivery, or remove the heartbeat.session field to fall back to the agent main session.`,
      ].join("\n"),
    );
  }
  return warnings;
}
