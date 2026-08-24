// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { hasSessionChangeReceivers } from "../session-change-receivers.js";
import {
  buildGatewaySessionEventFields,
  projectSessionEventActiveRunIds,
} from "../session-event-payload.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

type SessionChangedPayload = {
  sessionKey?: string;
  agentId?: string;
  reason: string;
  compacted?: boolean;
};

type SessionChangeContext = Pick<
  GatewayRequestContext,
  | "broadcastToConnIds"
  | "chatAbortControllers"
  | "getRuntimeConfig"
  | "getSessionEventSubscriberConnIds"
>;

type PendingSessionChange = {
  context: SessionChangeContext;
  dirty: boolean;
  firstDeferredAt?: number;
  key: string;
  payload: SessionChangedPayload;
  timer: ReturnType<typeof setTimeout> | null;
};

const SESSIONS_CHANGED_DEBOUNCE_MS = 100;
const SESSIONS_CHANGED_MAX_WAIT_MS = 500;
const sessionsMutationVersions = new WeakMap<object, number>();
const pendingChangesByContext = new WeakMap<object, Map<string, PendingSessionChange>>();
const pendingSessionChanges = new Set<PendingSessionChange>();

export function readSessionsMutationVersion(context: object): number {
  return sessionsMutationVersions.get(context) ?? 0;
}

function sessionChangeKey(payload: SessionChangedPayload): string {
  return `${payload.agentId ?? ""}\0${payload.sessionKey ?? ""}`;
}

function broadcastSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
): void {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const cfg = context.getRuntimeConfig();
  const unscopedOwnerAgentId = payload.sessionKey
    ? tryResolveSessionCompatibilityOwnerAgentId(cfg, payload.sessionKey)
    : undefined;
  const effectiveAgentId = payload.agentId ?? unscopedOwnerAgentId;
  const sessionRow = payload.sessionKey
    ? loadGatewaySessionRow(
        payload.sessionKey,
        effectiveAgentId ? { agentId: effectiveAgentId } : undefined,
      )
    : null;
  let rowAgentId: string | undefined;
  if (sessionRow) {
    try {
      rowAgentId = resolveAgentIdFromSessionKey(sessionRow.key, effectiveAgentId);
    } catch {
      rowAgentId = undefined;
    }
  }
  const activeRunState =
    sessionRow &&
    (sessionRow.key !== "global" || rowAgentId !== undefined || unscopedOwnerAgentId !== undefined)
      ? resolveVisibleActiveSessionRunState({
          context,
          requestedKey: payload.sessionKey ?? sessionRow.key,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          agentId: rowAgentId,
          defaultAgentId: unscopedOwnerAgentId,
        })
      : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      ts: Date.now(),
      ...(sessionRow
        ? {
            ...buildGatewaySessionEventFields({
              sessionRow,
              agentId: effectiveAgentId,
              status: activeRunState?.active ? (activeRunState.status ?? "running") : undefined,
              hasActiveRun: activeRunState?.active,
              activeRunIds: projectSessionEventActiveRunIds(activeRunState),
            }),
            effectiveFastMode: sessionRow.effectiveFastMode,
            effectiveFastModeSource: sessionRow.effectiveFastModeSource,
            fastAutoOnSeconds: sessionRow.fastAutoOnSeconds,
            traceLevel: sessionRow.traceLevel,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
    },
    connIds,
    {
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      dropIfSlow: true,
      // Scope only to a concrete key; a `[undefined]` scope filters no connection
      // correctly and would strip draft gating, so fall back to an unscoped send.
      ...(sessionRow?.key ? { sessionKeys: [sessionRow.key] } : {}),
    },
  );
}

function finishPendingSessionChange(pending: PendingSessionChange): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  pendingSessionChanges.delete(pending);
  const byKey = pendingChangesByContext.get(pending.context);
  if (byKey?.get(pending.key) === pending) {
    byKey.delete(pending.key);
  }
  if (pending.dirty) {
    broadcastSessionsChanged(pending.context, pending.payload);
  }
}

/** Flush trailing notifications and release every debounce timer before gateway shutdown. */
export function flushPendingSessionsChangedEvents(context?: object): void {
  for (const pending of pendingSessionChanges) {
    if (!context || pending.context === context) {
      finishPendingSessionChange(pending);
    }
  }
}

export function emitSessionsChanged(context: SessionChangeContext, payload: SessionChangedPayload) {
  // This counter is the sessions.list projection fence: every mutation advances it
  // synchronously, before event coalescing, so work started on an older value is never
  // joined or cached by a request that begins after the mutation.
  sessionsMutationVersions.set(context, readSessionsMutationVersion(context) + 1);
  invalidateSessionSharingSnapshot(payload.sessionKey);
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const key = sessionChangeKey(payload);
  const byKey = pendingChangesByContext.get(context) ?? new Map<string, PendingSessionChange>();
  pendingChangesByContext.set(context, byKey);
  const pending = byKey.get(key);
  if (pending) {
    pending.payload = payload;
    pending.dirty = true;
    pending.firstDeferredAt ??= Date.now();
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    // Keep resetting for a quiet-period trailing emit without letting a sustained
    // mutation stream postpone the authoritative row forever.
    const maxWaitRemaining = pending.firstDeferredAt + SESSIONS_CHANGED_MAX_WAIT_MS - Date.now();
    pending.timer = setTimeout(
      () => finishPendingSessionChange(pending),
      Math.max(0, Math.min(SESSIONS_CHANGED_DEBOUNCE_MS, maxWaitRemaining)),
    );
    pending.timer.unref?.();
    return;
  }

  // Lead after a quiet period for responsive UI, then coalesce a burst into one trailing
  // rebuild. The trailing row is loaded only when emitted, so it reflects the newest state.
  const next: PendingSessionChange = {
    context,
    dirty: false,
    key,
    payload,
    timer: null,
  };
  next.timer = setTimeout(() => finishPendingSessionChange(next), SESSIONS_CHANGED_DEBOUNCE_MS);
  next.timer.unref?.();
  byKey.set(key, next);
  pendingSessionChanges.add(next);
  broadcastSessionsChanged(context, payload);
}

export function emitSessionArchived(
  context: SessionChangeContext,
  sessionKey: string | undefined,
  agentId?: string,
): void {
  if (!sessionKey) {
    return;
  }
  emitSessionsChanged(context, {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    reason: "archive",
  });
}
