// Records system-level session events for restarts, forks, and resets.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveUserTimezone } from "../../agents/date-time.js";
import {
  markDelegateArtifactDeliveryUnavailable,
  prepareDelegateArtifactDelivery,
  recordDelegateArtifactDeliveryBinding,
} from "../../agents/delegate-artifacts.js";
import { replaceManagedDelegateReturnInPrompt } from "../../agents/internal-events.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import { emitContinuationQueueDrainSpan } from "../../infra/continuation-tracer.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import { isExecCompletionEvent } from "../../infra/heartbeat-events-filter.js";
import {
  ackSessionDelivery,
  loadPendingSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { acknowledgeSessionStateNotices } from "../../sessions/session-state-events.js";
import { decodeSessionStateNoticeContextKey } from "../../sessions/session-state-notices.js";
import { resolveContinuationRuntimeConfig } from "../continuation/config.js";

function isCronContextSystemEvent(event: SystemEvent): boolean {
  return event.contextKey?.startsWith("cron:") ?? false;
}

function selectGenericSystemEvents(
  events: readonly SystemEvent[],
  options?: { suppressHeartbeatOwnedEvents?: boolean },
): SystemEvent[] {
  // Exec completions and tagged cron events own dedicated heartbeat prompts
  // (buildExecEventPrompt / buildCronEventPrompt). During heartbeat runs, leave
  // cron entries queued for that owner; ordinary turns still drain them as the
  // fallback when a heartbeat was skipped before it could consume the event.
  return events.filter(
    (event) =>
      !isExecCompletionEvent(event.text) &&
      !(options?.suppressHeartbeatOwnedEvents === true && isCronContextSystemEvent(event)),
  );
}

function compactSystemEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.includes("reason periodic")) {
    return null;
  }
  // Filter out the actual heartbeat prompt, but not cron jobs that mention "heartbeat".
  // The heartbeat prompt starts with "Read HEARTBEAT.md" - cron payloads won't match this.
  if (lower.startsWith("read heartbeat.md")) {
    return null;
  }
  if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
    return null;
  }
  if (trimmed.startsWith("Node:")) {
    return trimmed.replace(/ · last input [^·]+/i, "").trim();
  }
  return trimmed;
}

function resolveSystemEventTimezone(cfg: OpenClawConfig) {
  const raw = normalizeOptionalString(cfg.agents?.defaults?.userTimezone);
  if (!raw) {
    return { mode: "local" as const };
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === "utc" || lowered === "gmt") {
    return { mode: "utc" as const };
  }
  if (lowered === "local" || lowered === "host") {
    return { mode: "local" as const };
  }
  if (lowered === "user") {
    return {
      mode: "iana" as const,
      timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
    };
  }
  const explicit = resolveTimezone(raw);
  return explicit ? { mode: "iana" as const, timeZone: explicit } : { mode: "local" as const };
}

function formatSystemEventTimestamp(ts: number, cfg: OpenClawConfig) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }
  const zone = resolveSystemEventTimezone(cfg);
  if (zone.mode === "utc") {
    return formatUtcTimestamp(date, { displaySeconds: true });
  }
  if (zone.mode === "local") {
    return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
  }
  return (
    formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ?? "unknown-time"
  );
}

/** Drain queued system events, format as `System:` lines, return the block text (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  suppressHeartbeatOwnedEvents?: boolean;
}): Promise<string | undefined> {
  const summaryLines: string[] = [];
  const systemLines: string[] = [];
  // Exec completions have a dedicated heartbeat prompt; leave those entries queued
  // so the heartbeat path can consume and deliver them.
  const selected = selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey), {
    suppressHeartbeatOwnedEvents: params.suppressHeartbeatOwnedEvents,
  });
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const currentSessionId = loadSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId }),
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  })?.sessionId;
  const runtime = resolveContinuationRuntimeConfig(params.cfg);
  const deferredManagedEvents = new Set<SystemEvent>();
  const terminalManagedKeys = new Set<string>();
  const refreshedManagedText = new Map<string, string>();
  const managedKey = (event: SystemEvent): string | undefined => {
    const receipt = event.delegateArtifactReceipt;
    if (!receipt) {
      return undefined;
    }
    return `${event.sessionDeliveryAckId ?? ""}\u0000${event.sessionDeliveryAckStateDir ?? ""}\u0000${receipt.dispatchId}\u0000${receipt.recipientSessionKey}\u0000${receipt.recipientSessionId}`;
  };
  for (const event of selected) {
    const receipt = event.delegateArtifactReceipt;
    const key = managedKey(event);
    if (!receipt || !key) {
      continue;
    }
    const artifactOptions = event.sessionDeliveryAckStateDir
      ? {
          options: {
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: event.sessionDeliveryAckStateDir,
            },
          },
        }
      : {};
    const durable = event.sessionDeliveryAckId
      ? await loadPendingSessionDelivery(
          event.sessionDeliveryAckId,
          event.sessionDeliveryAckStateDir,
        )
      : null;
    const managed =
      durable?.kind === "systemEvent" ? durable.managedDelegateArtifactDelivery : undefined;
    if (
      !managed ||
      managed.receipt.dispatchId !== receipt.dispatchId ||
      managed.receipt.recipientSessionKey !== receipt.recipientSessionKey ||
      managed.receipt.recipientSessionId !== receipt.recipientSessionId
    ) {
      markDelegateArtifactDeliveryUnavailable({
        dispatchId: receipt.dispatchId,
        recipientSessionKey: receipt.recipientSessionKey,
        recipientSessionId: receipt.recipientSessionId,
        reason: "delivery-state-unavailable",
        ...artifactOptions,
      });
      terminalManagedKeys.add(key);
      continue;
    }
    const prepared = prepareDelegateArtifactDelivery({
      projection: managed.projection,
      runtimeEnabled: runtime.enabled,
      crossSessionEnabled: runtime.crossSessionTargeting === "enabled",
      currentRecipientSessionId: currentSessionId,
      ...artifactOptions,
    });
    if (prepared.status === "deferred") {
      deferredManagedEvents.add(event);
      continue;
    }
    if (prepared.status === "acknowledged") {
      terminalManagedKeys.add(key);
      continue;
    }
    if (prepared.status === "unavailable") {
      markDelegateArtifactDeliveryUnavailable({
        dispatchId: receipt.dispatchId,
        recipientSessionKey: receipt.recipientSessionKey,
        recipientSessionId: receipt.recipientSessionId,
        reason:
          currentSessionId === receipt.recipientSessionId
            ? "delivery-state-unavailable"
            : "recipient-incarnation-changed",
        ...artifactOptions,
      });
      terminalManagedKeys.add(key);
      continue;
    }
    recordDelegateArtifactDeliveryBinding({
      dispatchId: receipt.dispatchId,
      recipientSessionKey: receipt.recipientSessionKey,
      recipientSessionId: receipt.recipientSessionId,
      phase: "attempt",
      now: prepared.projection.arrivalContext.deliveredAt,
      availability: prepared.projection.arrivalContext.availability,
      ...artifactOptions,
    });
    const refreshed = prepareDelegateArtifactDelivery({
      projection: managed.projection,
      runtimeEnabled: runtime.enabled,
      crossSessionEnabled: runtime.crossSessionTargeting === "enabled",
      currentRecipientSessionId: currentSessionId,
      ...artifactOptions,
    });
    if (refreshed.status === "deferred") {
      deferredManagedEvents.add(event);
      continue;
    }
    if (refreshed.status === "acknowledged") {
      terminalManagedKeys.add(key);
      continue;
    }
    if (refreshed.status === "unavailable") {
      markDelegateArtifactDeliveryUnavailable({
        dispatchId: receipt.dispatchId,
        recipientSessionKey: receipt.recipientSessionKey,
        recipientSessionId: receipt.recipientSessionId,
        reason: "delivery-state-unavailable",
        ...artifactOptions,
      });
      terminalManagedKeys.add(key);
      continue;
    }
    refreshedManagedText.set(
      key,
      replaceManagedDelegateReturnInPrompt(event.text, refreshed.projection),
    );
  }
  const queued = consumeSelectedSystemEventEntries(
    params.sessionKey,
    selected.filter((event) => !deferredManagedEvents.has(event)),
  ).map((event) => {
    const key = managedKey(event);
    const text = key ? refreshedManagedText.get(key) : undefined;
    return text ? { ...event, text } : event;
  });
  const deliverable = queued.filter(
    (event) =>
      (!event.expectedSessionId || event.expectedSessionId === currentSessionId) &&
      !terminalManagedKeys.has(managedKey(event) ?? ""),
  );
  const deliverableEvents = new Set(deliverable);
  const sessionDeliveryAcks = new Map<
    string,
    {
      id: string;
      stateDir?: string;
      delegateArtifactReceipt?: NonNullable<SystemEvent["delegateArtifactReceipt"]>;
      deliveryEligible: boolean;
    }
  >();
  for (const event of queued) {
    const id = normalizeOptionalString(event.sessionDeliveryAckId);
    if (!id) {
      continue;
    }
    const stateDir = normalizeOptionalString(event.sessionDeliveryAckStateDir);
    const dedupeKey = `${id}\u0000${stateDir ?? ""}`;
    const deliveryEligible = deliverableEvents.has(event);
    const delegateArtifactReceipt = terminalManagedKeys.has(managedKey(event) ?? "")
      ? undefined
      : event.delegateArtifactReceipt;
    sessionDeliveryAcks.set(dedupeKey, {
      id,
      ...(stateDir ? { stateDir } : {}),
      ...(delegateArtifactReceipt ? { delegateArtifactReceipt } : {}),
      deliveryEligible,
    });
  }
  for (const ack of sessionDeliveryAcks.values()) {
    try {
      if (ack.delegateArtifactReceipt) {
        const receipt = ack.delegateArtifactReceipt;
        const options = ack.stateDir
          ? { env: { ...process.env, OPENCLAW_STATE_DIR: ack.stateDir } }
          : undefined;
        if (ack.deliveryEligible) {
          recordDelegateArtifactDeliveryBinding({
            dispatchId: receipt.dispatchId,
            recipientSessionKey: receipt.recipientSessionKey,
            recipientSessionId: receipt.recipientSessionId,
            phase: "acknowledged",
            ...(options ? { options } : {}),
          });
        } else {
          markDelegateArtifactDeliveryUnavailable({
            dispatchId: receipt.dispatchId,
            recipientSessionKey: receipt.recipientSessionKey,
            recipientSessionId: receipt.recipientSessionId,
            reason: "recipient-incarnation-changed",
            ...(options ? { options } : {}),
          });
        }
      }
      await ackSessionDelivery(ack.id, ack.stateDir);
    } catch (error) {
      defaultRuntime.log(
        `[session-system-events] failed to ack consumed session delivery ${ack.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const sessionStateTargets = deliverable
    .map((event) =>
      event.contextKey ? decodeSessionStateNoticeContextKey(event.contextKey) : undefined,
    )
    .filter((target): target is string => target !== undefined);
  if (sessionStateTargets.length > 0) {
    acknowledgeSessionStateNotices(params.sessionKey, sessionStateTargets);
  }
  const drainedContinuationCount = deliverable.filter((event) =>
    event.text.startsWith("[continuation:"),
  ).length;
  const traceparent = deliverable.find((event) => event.traceparent)?.traceparent;
  emitContinuationQueueDrainSpan({
    drainedCount: deliverable.length,
    drainedContinuationCount,
    ...(traceparent ? { traceparent } : {}),
    log: (message) => defaultRuntime.log(message),
  });
  for (const event of deliverable) {
    const compacted = compactSystemEvent(event.text);
    if (!compacted) {
      continue;
    }
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    let index = 0;
    for (const subline of compacted.split("\n")) {
      systemLines.push(`System: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
      index += 1;
    }
  }
  if (params.isMainSession && params.isNewSession) {
    const summary = await buildChannelSummary(params.cfg);
    if (summary.length > 0) {
      for (const line of summary) {
        for (const subline of line.split("\n")) {
          summaryLines.push(`System: ${subline}`);
        }
      }
    }
  }
  if (summaryLines.length === 0 && systemLines.length === 0) {
    return undefined;
  }

  // Each sub-line gets its own prefix so continuation lines can't be mistaken
  // for regular user content.
  return summaryLines.length > 0
    ? [...summaryLines, ...systemLines].join("\n")
    : systemLines.join("\n");
}
