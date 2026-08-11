import fs from "node:fs";
/** Doctor warnings for heartbeat.session values that resolve to missing delivery sessions. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import { resolveHeartbeatDeliveryTarget } from "../infra/outbound/targets.js";
import { loadLegacySessionStore } from "../infra/state-migrations.legacy-session-store.js";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  return listAgentEntries(cfg).some((entry) => Boolean(entry?.heartbeat));
}

function resolveHeartbeatConfig(cfg: OpenClawConfig, agentId: string): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  return defaults || overrides ? { ...defaults, ...overrides } : undefined;
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
 * a missing last route skips before the model, while a missing explicit target
 * runs and drops its reply. Common cause: the configured Slack
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
    if (target === "none") {
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
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: storeAgentId });
    const entry =
      loadSessionEntryReadOnly({
        agentId: storeAgentId,
        sessionKey: canonicalSession,
        storePath,
      }) ??
      (fs.existsSync(storePath) ? loadLegacySessionStore(storePath)[canonicalSession] : undefined);
    if (entry) {
      continue;
    }
    const ownerTarget = target === undefined || target === "owner";
    const missingRouteOutcome = ownerTarget
      ? `  Heartbeats will skip with reason="no-route" until a configured owner resolves to a direct message.`
      : deliveryWithoutSession.reason === "no-route"
        ? `  Heartbeats will skip with reason="no-route" until that session has a delivery route.`
        : `  Heartbeats will run but resolve delivery to channel="none"/reason="no-target", so replies are dropped.`;
    const fix = ownerTarget
      ? `  Fix: set commands.ownerAllowFrom or a channel allowFrom to a direct-message owner, set heartbeat.target="none", or choose an explicit heartbeat target.`
      : `  Fix: point heartbeat.session at a session the agent actually owns, set heartbeat.target="none" to suppress delivery, or remove the heartbeat.session field to fall back to the agent main session.`;
    warnings.push(
      [
        `- Agent ${agentId} heartbeat.session pins ${configuredSession} (resolved to ${canonicalSession}) but that session has no entry in ${storePath}.`,
        missingRouteOutcome,
        fix,
      ].join("\n"),
    );
  }
  return warnings;
}
