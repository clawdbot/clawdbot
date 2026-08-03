import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-dispatch.js";
import {
  sendUnresumableSessionNotice,
  writeUnresumableSessionNotice,
} from "./main-session-restart-recovery-notice.js";
import {
  buildRestartRecoveryExpectedState,
  log,
  MAX_RECOVERY_RETRIES,
} from "./main-session-restart-recovery-shared.js";

const TOMBSTONED_SESSION_NOTICE =
  "I couldn't recover this session after repeated gateway restarts. " +
  "Use /new or /reset to start a replacement session.";

async function claimMainRestartRecoveryTombstone(params: {
  observation: MainSessionRecoveryObservation;
  reason: string;
  storePath: string;
  sessionKey: string;
}): Promise<SessionEntry | null> {
  const claim = await commitMainSessionRecovery({
    command: {
      kind: "tombstone",
      now: Date.now(),
      observation: params.observation,
      reason: params.reason,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (claim.transition.kind !== "tombstoned" || !claim.entry) {
    return null;
  }
  log.warn(`tombstoned main-session restart recovery: ${params.sessionKey} (${params.reason})`);
  return claim.entry;
}

export async function tombstoneMainRestartRecoveryWithNotice(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
}): Promise<"notice_failed" | "skipped" | "tombstoned"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (!deliveryContext) {
    // The transcript notice and tombstone share one SQLite transaction so a
    // foreground takeover cannot leave behind a false terminal notice.
    let entry = params.entry;
    let observation = params.observation;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recoveryState = entry.mainRestartRecovery;
      if (
        !recoveryState ||
        recoveryState.cycleId !== observation.cycleId ||
        recoveryState.revision !== observation.revision
      ) {
        return "skipped";
      }
      const now = Date.now();
      const notice = await writeUnresumableSessionNotice({
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        entry,
        expectedSessionState: buildRestartRecoveryExpectedState(entry, observation),
        sessionKey: params.sessionKey,
        sessionLifecyclePatch: {
          abortedLastRun: false,
          endedAt: now,
          mainRestartRecovery: {
            ...recoveryState,
            revision: recoveryState.revision + 1,
            tombstone: { reason: params.reason },
          },
          runtimeMs: Math.max(0, now - (entry.startedAt ?? now)),
          status: "failed",
          updatedAt: now,
        },
        storePath: params.storePath,
        text: TOMBSTONED_SESSION_NOTICE,
      });
      if (notice === "written") {
        return "tombstoned";
      }
      if (notice === "failed") {
        return "notice_failed";
      }
      const current = loadSessionEntry({
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        readConsistency: "latest",
      }) as SessionEntry | undefined;
      const state = current?.mainRestartRecovery;
      if (
        !current ||
        current.sessionId !== params.entry.sessionId ||
        state?.cycleId !== params.observation.cycleId ||
        state.tombstone ||
        current.status !== "running" ||
        current.abortedLastRun !== true ||
        state.chargedAttempts < MAX_RECOVERY_RETRIES
      ) {
        return "skipped";
      }
      entry = current;
      observation = {
        sessionId: current.sessionId,
        cycleId: state.cycleId,
        revision: state.revision,
      };
    }
    return "notice_failed";
  }
  const tombstonedEntry = await claimMainRestartRecoveryTombstone(params);
  if (!tombstonedEntry) {
    return "skipped";
  }
  await sendUnresumableSessionNotice({
    deliveryContext,
    entry: tombstonedEntry,
    gatewayRuntime: params.gatewayRuntime,
    reason: params.reason,
    sessionKey: params.sessionKey,
    text: TOMBSTONED_SESSION_NOTICE,
  });
  return "tombstoned";
}
