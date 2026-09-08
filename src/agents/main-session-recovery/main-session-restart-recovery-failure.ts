import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  type SessionTranscriptTurnExpectedState,
  type SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-accessor.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-dispatch.js";
import {
  mainSessionRecoveryLog,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

const TOMBSTONED_SESSION_NOTICE =
  "I couldn't continue this session after a gateway restart. " +
  "Your transcript is safe. In WebChat, use Resume in new session to continue it; " +
  "in other channels, use /new or /reset to start a replacement session.";

function buildRestartRecoveryTombstoneNoticeKey(entry: SessionEntry): string {
  const interruptedRunId =
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ??
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ??
    entry.sessionId;
  return `main-session-restart-recovery:${interruptedRunId}:failed-notice`;
}

async function sendRestartRecoveryTombstoneNotice(params: {
  deliveryContext: DeliveryContext & { channel: string; to: string };
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  reason: string;
  sessionKey: string;
}): Promise<void> {
  try {
    await params.gatewayRuntime.sendRecoveryNotice({
      channel: params.deliveryContext.channel,
      to: params.deliveryContext.to,
      accountId: params.deliveryContext.accountId,
      threadId: params.deliveryContext.threadId,
      text: TOMBSTONED_SESSION_NOTICE,
      idempotencyKey: buildRestartRecoveryTombstoneNoticeKey(params.entry),
    });
    mainSessionRecoveryLog.info(
      `sent restart recovery tombstone notice: ${params.sessionKey} (${params.reason})`,
    );
  } catch (error) {
    mainSessionRecoveryLog.warn(
      `failed to send restart recovery tombstone notice ${params.sessionKey}: ${String(error)}`,
    );
  }
}

async function writeRestartRecoveryTombstoneNotice(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  expectedSessionState: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch: SessionTranscriptTurnLifecyclePatch;
}): Promise<"failed" | "stale" | "written"> {
  const result = await appendAssistantMessageToSessionTranscript({
    ...params,
    expectedSessionId: params.entry.sessionId,
    text: TOMBSTONED_SESSION_NOTICE,
    idempotencyKey: buildRestartRecoveryTombstoneNoticeKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    mainSessionRecoveryLog.warn(
      `failed to write restart recovery tombstone notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok
    ? "written"
    : "code" in result && result.code === "session-rebound"
      ? "stale"
      : "failed";
}

async function claimMainRestartRecoveryTombstone(
  params: MainSessionRecoveryStoreTarget & {
    observation: MainSessionRecoveryObservation;
    reason: string;
  },
): Promise<SessionEntry | null> {
  const claim = await commitMainSessionRecovery({
    command: {
      kind: "tombstone",
      now: Date.now(),
      observation: params.observation,
      reason: params.reason,
    },
    requireWriteSuccess: true,
    target: params,
  });
  if (claim.transition.kind !== "tombstoned" || !claim.entry) {
    return null;
  }
  mainSessionRecoveryLog.warn(
    `tombstoned main-session restart recovery: ${params.sessionKey} (${params.reason})`,
  );
  return claim.entry;
}

export async function tombstoneMainRestartRecoveryWithNotice(params: {
  agentId: string;
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
      const notice = await writeRestartRecoveryTombstoneNotice({
        ...params,
        entry,
        expectedSessionState: buildRestartRecoveryExpectedState(entry, observation),
        sessionLifecyclePatch: {
          abortedLastRun: false,
          endedAt: now,
          lifecycleRunId: undefined,
          lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
          mainRestartRecovery: {
            ...recoveryState,
            revision: recoveryState.revision + 1,
            tombstone: { reason: params.reason },
          },
          runtimeMs: Math.max(0, now - (entry.startedAt ?? now)),
          status: "failed",
          updatedAt: now,
        },
      });
      if (notice === "written") {
        return "tombstoned";
      }
      if (notice === "failed") {
        return "notice_failed";
      }
      const current = loadSessionEntry({
        agentId: params.agentId,
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
        current.abortedLastRun !== true
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
  await sendRestartRecoveryTombstoneNotice({
    ...params,
    deliveryContext,
    entry: tombstonedEntry,
  });
  return "tombstoned";
}
