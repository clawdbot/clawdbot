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
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
import {
  isSessionRecipientAuthorityCurrent,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
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
// Records system-level session events for restarts, forks, and resets.
import { selectAgentSystemEvents } from "../../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { acknowledgeSessionStateNotices } from "../../sessions/session-state-events.js";
import { decodeSessionStateNoticeContextKey } from "../../sessions/session-state-notices.js";
import { resolveContinuationRuntimeConfig } from "../continuation/config.js";
import {
  createPreparedSystemEventAuthorityOwner,
  readAdoptedSystemEventDeliveryIds,
  readPreparedSystemEventAuthorityKey,
  resolveFinalSystemEventAdoption,
  settleStaleSystemEventAuthority,
  type PreparedFormattedSystemEvents,
  type PreparedManagedSystemEventDelivery,
  type PreparedSystemEventBlock,
} from "./session-system-event-adoption.js";

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
  // Keep retired heartbeat prompts out of replayed legacy system events.
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

type ManagedDeliverySettlement = {
  event: SystemEvent;
  id: string;
  stateDir?: string;
  receipt?: NonNullable<SystemEvent["delegateArtifactReceipt"]>;
  deliveryEligible: boolean;
};

async function settleManagedDelivery(
  sessionKey: string,
  settlement: ManagedDeliverySettlement,
): Promise<void> {
  const options = settlement.stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: settlement.stateDir } }
    : undefined;
  try {
    if (settlement.receipt) {
      const receipt = settlement.receipt;
      if (settlement.deliveryEligible) {
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
    await ackSessionDelivery(settlement.id, settlement.stateDir);
    consumeSelectedSystemEventEntries(sessionKey, [settlement.event]);
  } catch (error) {
    defaultRuntime.log(
      `[session-system-events] failed to settle adopted session delivery ${settlement.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

/**
 * Prepare queued system events for one prompt. Managed deliveries remain
 * pending until the caller durably adopts the resulting user turn.
 */
export async function prepareFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  suppressHeartbeatOwnedEvents?: boolean;
}): Promise<PreparedFormattedSystemEvents> {
  const summaryLines: string[] = [];
  const blocks: PreparedSystemEventBlock[] = [];
  // Exec completions have a dedicated heartbeat prompt; leave those entries queued
  // so the heartbeat path can consume and deliver them.
  // Upstream scopes queued events to the owning agent before generic selection;
  // keep that ownership filter ahead of our delivery-ack/session filtering.
  let selected = selectGenericSystemEvents(
    selectAgentSystemEvents(peekSystemEventEntries(params.sessionKey), params.agentId),
    { suppressHeartbeatOwnedEvents: params.suppressHeartbeatOwnedEvents },
  );
  // Storage must resolve under the SAME agent the ownership filter selected for,
  // or a global-scope key under a non-default agent reads the wrong store.
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey, params.agentId);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const authorityScope = {
    agentId,
    sessionKey: params.sessionKey,
    storePath,
  };
  const currentSessionEntry = loadSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  const currentSessionId = currentSessionEntry?.sessionId;
  const removeStaleAuthorityEvents = async () => {
    const staleAuthorityEvents = selected.filter(
      (event) =>
        event.recipientAuthority &&
        !isSessionRecipientAuthorityCurrent(authorityScope, event.recipientAuthority),
    );
    for (const event of staleAuthorityEvents) {
      await settleStaleSystemEventAuthority({
        event,
        sessionKey: params.sessionKey,
      });
    }
    if (staleAuthorityEvents.length > 0) {
      const stale = new Set(staleAuthorityEvents);
      selected = selected.filter((event) => !stale.has(event));
    }
  };
  // Adoption-scoped events settle only after the turn is durably adopted, so a
  // crash between the transcript write and the queue ack leaves an ack id that
  // IS already adopted but whose row is still pending. Both kinds must consult
  // the transcript, or a plain adoption-scoped notice would be re-injected.
  const hasManagedDelivery = selected.some(
    (event) =>
      event.sessionDeliveryAckId &&
      (event.delegateArtifactReceipt || event.sessionDeliveryAwaitsTurnAdoption),
  );
  const adoptedDeliveryIds =
    currentSessionId && hasManagedDelivery
      ? readAdoptedSystemEventDeliveryIds(
          await loadTranscriptEvents({
            agentId,
            sessionId: currentSessionId,
            sessionKey: params.sessionKey,
            storePath,
          }),
        )
      : new Set<string>();
  await removeStaleAuthorityEvents();
  const authorityOwner = createPreparedSystemEventAuthorityOwner({
    scope: authorityScope,
    events: selected,
  });
  const runtime = resolveContinuationRuntimeConfig(params.cfg);
  const deferredManagedEvents = new Set<SystemEvent>();
  const pendingManagedKeys = new Set<string>();
  const terminalManagedSettlements: ManagedDeliverySettlement[] = [];
  const pendingManagedSettlements: ManagedDeliverySettlement[] = [];
  const refreshedManagedText = new Map<string, string>();
  const managedKey = (event: SystemEvent): string | undefined => {
    const receipt = event.delegateArtifactReceipt;
    if (!receipt) {
      return undefined;
    }
    return `${event.sessionDeliveryAckId ?? ""}\u0000${event.sessionDeliveryAckStateDir ?? ""}\u0000${receipt.dispatchId}\u0000${receipt.recipientSessionKey}\u0000${receipt.recipientSessionId}`;
  };
  const refreshManagedEvent = (event: SystemEvent): SystemEvent => {
    const key = managedKey(event);
    const text = key ? refreshedManagedText.get(key) : undefined;
    return text ? { ...event, text } : event;
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
      if (event.sessionDeliveryAckId) {
        terminalManagedSettlements.push({
          event,
          id: event.sessionDeliveryAckId,
          ...(event.sessionDeliveryAckStateDir
            ? { stateDir: event.sessionDeliveryAckStateDir }
            : {}),
          deliveryEligible: false,
        });
      }
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
      if (event.sessionDeliveryAckId) {
        terminalManagedSettlements.push({
          event,
          id: event.sessionDeliveryAckId,
          ...(event.sessionDeliveryAckStateDir
            ? { stateDir: event.sessionDeliveryAckStateDir }
            : {}),
          receipt,
          deliveryEligible: true,
        });
      }
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
      if (event.sessionDeliveryAckId) {
        terminalManagedSettlements.push({
          event,
          id: event.sessionDeliveryAckId,
          ...(event.sessionDeliveryAckStateDir
            ? { stateDir: event.sessionDeliveryAckStateDir }
            : {}),
          deliveryEligible: false,
        });
      }
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
      if (event.sessionDeliveryAckId) {
        terminalManagedSettlements.push({
          event,
          id: event.sessionDeliveryAckId,
          ...(event.sessionDeliveryAckStateDir
            ? { stateDir: event.sessionDeliveryAckStateDir }
            : {}),
          receipt,
          deliveryEligible: true,
        });
      }
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
      if (event.sessionDeliveryAckId) {
        terminalManagedSettlements.push({
          event,
          id: event.sessionDeliveryAckId,
          ...(event.sessionDeliveryAckStateDir
            ? { stateDir: event.sessionDeliveryAckStateDir }
            : {}),
          deliveryEligible: false,
        });
      }
      continue;
    }
    refreshedManagedText.set(
      key,
      replaceManagedDelegateReturnInPrompt(event.text, refreshed.projection),
    );
    const deliveryId = normalizeOptionalString(event.sessionDeliveryAckId);
    if (!deliveryId) {
      continue;
    }
    const settlement: ManagedDeliverySettlement = {
      event,
      id: deliveryId,
      ...(event.sessionDeliveryAckStateDir ? { stateDir: event.sessionDeliveryAckStateDir } : {}),
      receipt,
      deliveryEligible: currentSessionId === receipt.recipientSessionId,
    };
    if (adoptedDeliveryIds.has(deliveryId) || !settlement.deliveryEligible) {
      terminalManagedSettlements.push(settlement);
    } else {
      pendingManagedKeys.add(key);
      pendingManagedSettlements.push(settlement);
    }
  }
  for (const settlement of terminalManagedSettlements) {
    await settleManagedDelivery(params.sessionKey, settlement);
  }
  // Classify adoption-scoped deliveries BEFORE the prompt is assembled: an id
  // the persisted turn already adopted must be settled and excluded, not
  // re-injected.
  const adoptionScopedDeliveries: PreparedManagedSystemEventDelivery[] = [];
  const seenAdoptionScopedIds = new Set<string>();
  const alreadyAdoptedAckIds: { id: string; stateDir?: string }[] = [];
  // Keyed by ack id, not object identity: consumeSelectedSystemEventEntries
  // returns different instances than the peeked entries classified here.
  const excludedAdoptedAckIds = new Set<string>();
  for (const event of selected) {
    if (event.delegateArtifactReceipt || !event.sessionDeliveryAwaitsTurnAdoption) {
      continue;
    }
    const id = normalizeOptionalString(event.sessionDeliveryAckId);
    if (!id || seenAdoptionScopedIds.has(id)) {
      continue;
    }
    seenAdoptionScopedIds.add(id);
    const stateDir = normalizeOptionalString(event.sessionDeliveryAckStateDir);
    if (adoptedDeliveryIds.has(id)) {
      // The persisted turn already adopted this id; only the queue ack was lost.
      // Settle it and keep it out of this prompt so a restart cannot surface the
      // same outcome twice.
      alreadyAdoptedAckIds.push({ id, ...(stateDir ? { stateDir } : {}) });
      excludedAdoptedAckIds.add(id);
      continue;
    }
    const authorityKey = readPreparedSystemEventAuthorityKey(event);
    adoptionScopedDeliveries.push({
      id,
      acknowledge: async () => {
        await ackSessionDelivery(id, stateDir);
      },
      ...(authorityKey ? { authorityKey } : {}),
    });
  }
  for (const ack of alreadyAdoptedAckIds) {
    try {
      await ackSessionDelivery(ack.id, ack.stateDir);
    } catch (error) {
      defaultRuntime.log(
        `[session-system-events] failed to settle already-adopted session delivery ${ack.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const queued = consumeSelectedSystemEventEntries(
    params.sessionKey,
    selected.filter((event) => !event.delegateArtifactReceipt && !deferredManagedEvents.has(event)),
  ).map(refreshManagedEvent);
  const deliverable = queued.filter(
    (event) =>
      !(event.sessionDeliveryAckId && excludedAdoptedAckIds.has(event.sessionDeliveryAckId)) &&
      (!event.expectedSessionId || event.expectedSessionId === currentSessionId),
  );
  const pendingManagedEvents = selected
    .filter((event) => pendingManagedKeys.has(managedKey(event) ?? ""))
    .map(refreshManagedEvent);
  const promptEvents = [...deliverable, ...pendingManagedEvents];
  const sessionDeliveryAcks = new Map<
    string,
    {
      id: string;
      stateDir?: string;
    }
  >();
  // Adoption-scoped events are NOT acked here: prompt preparation is not
  // adoption, and a crash or admission failure after this point would otherwise
  // complete the durable row with nothing delivered. They were classified above
  // and settle via settleManagedSystemEventsAfterTurnAdoption.
  for (const event of selected.filter(
    (entry) => !entry.delegateArtifactReceipt && !entry.sessionDeliveryAwaitsTurnAdoption,
  )) {
    const id = normalizeOptionalString(event.sessionDeliveryAckId);
    if (!id) {
      continue;
    }
    const stateDir = normalizeOptionalString(event.sessionDeliveryAckStateDir);
    const dedupeKey = `${id}\u0000${stateDir ?? ""}`;
    sessionDeliveryAcks.set(dedupeKey, {
      id,
      ...(stateDir ? { stateDir } : {}),
    });
  }
  for (const ack of sessionDeliveryAcks.values()) {
    try {
      await ackSessionDelivery(ack.id, ack.stateDir);
    } catch (error) {
      defaultRuntime.log(
        `[session-system-events] failed to ack consumed session delivery ${ack.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const sessionStateTargets = promptEvents
    .map((event) =>
      event.contextKey ? decodeSessionStateNoticeContextKey(event.contextKey) : undefined,
    )
    .filter((target): target is string => target !== undefined);
  if (sessionStateTargets.length > 0) {
    acknowledgeSessionStateNotices(params.sessionKey, sessionStateTargets);
  }
  const drainedContinuationCount = promptEvents.filter((event) =>
    event.text.startsWith("[continuation:"),
  ).length;
  const traceparent = promptEvents.find((event) => event.traceparent)?.traceparent;
  emitContinuationQueueDrainSpan({
    drainedCount: promptEvents.length,
    drainedContinuationCount,
    ...(traceparent ? { traceparent } : {}),
    log: (message) => defaultRuntime.log(message),
  });
  for (const event of promptEvents) {
    const compacted = compactSystemEvent(event.text);
    if (!compacted) {
      continue;
    }
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    const lines = compacted
      .split("\n")
      .map((subline, index) => `System: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
    // Inbound text is deliberately not rewritten to neutralize look-alike `System:` lines.
    // Role separation plus external-content wrapping is the boundary.
    // This is an explicit product decision.
    const authorityKey = readPreparedSystemEventAuthorityKey(event);
    blocks.push({
      ...(event.sessionDeliveryAckId
        ? { key: `session-delivery:${event.sessionDeliveryAckId}` }
        : {}),
      text: lines.join("\n"),
      ...(authorityKey ? { authorityKey } : {}),
    });
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
  if (summaryLines.length > 0) {
    blocks.unshift({ key: "session-summary", text: summaryLines.join("\n") });
  }
  const pendingManagedDeliveries = pendingManagedSettlements.map((settlement) => {
    const authorityKey = readPreparedSystemEventAuthorityKey(settlement.event);
    const acknowledge = () => settleManagedDelivery(params.sessionKey, settlement);
    return authorityKey
      ? { id: settlement.id, acknowledge, authorityKey }
      : { id: settlement.id, acknowledge };
  });
  return {
    blocks,
    managedDeliveries: [...pendingManagedDeliveries, ...adoptionScopedDeliveries],
    ...(authorityOwner ? { authorityOwner } : {}),
  };
}

/** Drain queued system events and immediately acknowledge prepared deliveries. */
export async function drainFormattedSystemEvents(
  params: Parameters<typeof prepareFormattedSystemEvents>[0],
): Promise<string | undefined> {
  const prepared = await prepareFormattedSystemEvents(params);
  let adoption = resolveFinalSystemEventAdoption({ prepared: [prepared] });
  while (adoption.kind === "settle-stale") {
    await adoption.settle();
    adoption = resolveFinalSystemEventAdoption({ prepared: [prepared] });
  }
  for (const delivery of adoption.managedDeliveries.values()) {
    await delivery.acknowledge();
  }
  let finalAdoption = resolveFinalSystemEventAdoption({ prepared: [prepared] });
  while (finalAdoption.kind === "settle-stale") {
    await finalAdoption.settle();
    finalAdoption = resolveFinalSystemEventAdoption({ prepared: [prepared] });
  }
  return finalAdoption.blocks.length > 0
    ? finalAdoption.blocks.map((block) => block.text).join("\n")
    : undefined;
}
