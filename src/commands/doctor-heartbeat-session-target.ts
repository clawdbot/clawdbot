import fs from "node:fs";
/** Doctor warnings for heartbeat.session values that resolve to missing delivery sessions. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import { resolveHeartbeatDeliveryTarget } from "../infra/outbound/targets.js";
import { loadLegacySessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { resolveAgentIdFromSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";

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
  for (const { agentId, heartbeat: heartbeatConfig } of resolveHeartbeatAgents(cfg)) {
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
      agentId,
      heartbeat: heartbeatConfig,
    });
    if (deliveryWithoutSession.channel !== "none" && deliveryWithoutSession.to) {
      continue;
    }
    const candidateSession = toAgentStoreSessionKey({
      agentId,
      requestKey: configuredSession,
      mainKey: cfg.session?.mainKey,
    });
    if (isSubagentSessionKey(candidateSession)) {
      continue;
    }
    const canonicalSession = canonicalizeMainSessionAlias({
      cfg,
      agentId,
      sessionKey: candidateSession,
    });
    if (
      canonicalSession === "global" ||
      isSubagentSessionKey(canonicalSession) ||
      resolveAgentIdFromSessionKey(canonicalSession) !== agentId
    ) {
      continue;
    }
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const entry =
      loadSessionEntryReadOnly({
        agentId,
        sessionKey: canonicalSession,
        storePath,
      }) ??
      (!storePath.endsWith(".sqlite") && fs.existsSync(storePath)
        ? loadLegacySessionStore(storePath)[canonicalSession]
        : undefined);
    if (entry) {
      continue;
    }
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
    }).path;
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
        `- Agent ${agentId} heartbeat.session pins ${configuredSession} (resolved to ${canonicalSession}) but that session has no entry in ${databasePath}.`,
        missingRouteOutcome,
        fix,
      ].join("\n"),
    );
  }
  return warnings;
}
