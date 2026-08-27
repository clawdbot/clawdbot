// Projects a completed outbound delivery into the exact target conversation generation.
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { SessionDeliveryState, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  getSessionWorkAdmissionRelease,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { formatErrorMessage } from "../errors.js";
import { generateSecureUuid } from "../secure-random.js";
import { withSystemEventOwner } from "../system-event-ownership.js";
import { enqueueSystemEventDeferredDuringHeartbeat } from "../system-events.js";
import {
  bindOutboundSessionEntry,
  selectAuthoritativeOutboundTargetSessionRoute,
  type AuthoritativeOutboundTargetSessionRoute,
  type OutboundSessionRoute,
} from "./outbound-session.js";
import {
  projectDeliveredOutboundPayloadsForMirror,
  type NormalizedOutboundPayload,
} from "./payloads.js";
import type {
  TargetSessionProjectionCompletion,
  TargetSessionProjectionCoordinator,
} from "./target-session-projection.types.js";

export type { TargetSessionProjectionCoordinator } from "./target-session-projection.types.js";

type TargetSessionIdentity = {
  sessionId: string;
  lifecycleRevision?: string;
};

type TargetSessionSnapshot = {
  entry?: SessionEntry;
  identity: TargetSessionIdentity | null;
  delivery?: SessionDeliveryState;
};

export type PreparedTargetSessionProjection = {
  agentId: string;
  route: OutboundSessionRoute;
  storePath: string;
  observedSession: TargetSessionIdentity | null;
  observedDelivery?: SessionDeliveryState;
  isCurrent: () => boolean;
};

export type TargetSessionProjectionResult =
  | { status: "committed"; warnings: string[]; session: TargetSessionIdentity | null }
  | { status: "skipped"; reason: string };

export function createTargetSessionProjectionCoordinator(
  readCurrentConfig: () => OpenClawConfig,
): TargetSessionProjectionCoordinator {
  return {
    readCurrentConfig,
    sessions: new Map(),
    completions: new Set(),
  };
}

export type TargetSessionProjectionCapture = {
  cfg: OpenClawConfig;
  prepared: PreparedTargetSessionProjection;
  channel: ChannelId;
  accountId?: string;
  coordinator?: TargetSessionProjectionCoordinator;
  idempotencyKey: string;
  completion?: Promise<TargetSessionProjectionCompletion>;
  /** Effective post-hook payloads with identified platform delivery. */
  deliveredPayloads: NormalizedOutboundPayload[];
};

export type TargetSessionProjectionSelection =
  | { status: "ordinary" }
  | { status: "captured"; capture: TargetSessionProjectionCapture }
  | { status: "unavailable" };

function targetsExactSourceSession(params: {
  cfg: OpenClawConfig;
  sourceAgentId: string;
  sourceSessionKey: string;
  route: OutboundSessionRoute | null;
}): boolean {
  const route = params.route;
  if (!route || route.sessionKey.trim() !== params.sourceSessionKey.trim()) {
    return false;
  }
  const sourceAgentId = normalizeAgentId(params.sourceAgentId);
  if (route.sessionKey === "global" || route.baseSessionKey === "global") {
    return (
      params.cfg.session?.scope === "global" &&
      route.sessionKey === "global" &&
      route.baseSessionKey === "global"
    );
  }
  try {
    return (
      resolveAgentIdFromSessionKey(route.sessionKey) === sourceAgentId &&
      resolveAgentIdFromSessionKey(route.baseSessionKey) === sourceAgentId
    );
  } catch {
    return false;
  }
}

/** Records exact transport-visible content without exposing private authority to the model. */
export function recordTargetSessionProjectionDeliveredPayload(
  capture: TargetSessionProjectionCapture | undefined,
  payload: NormalizedOutboundPayload,
): void {
  if (!capture) {
    return;
  }
  capture.deliveredPayloads.push({
    ...payload,
    mediaUrls: payload.mediaUrls.slice(),
  });
}

const MAX_TARGET_SESSION_AWARENESS_CHARS = 1_024;

export type HeartbeatTargetSessionAwarenessOutcome =
  | { status: "delivered"; text?: string }
  | { status: "failed"; mayHaveReachedRecipient: boolean }
  | { status: "uncertain"; text?: string };

function formatBoundedTargetSessionAwareness(prefix: string, text: string | undefined): string {
  const fallback = `${prefix}\n[No text representation was available.]`;
  if (!text) {
    return fallback;
  }
  const full = `${prefix}\n${text}`;
  if (full.length <= MAX_TARGET_SESSION_AWARENESS_CHARS) {
    return full;
  }
  const suffix = "\n[truncated]";
  return `${truncateUtf16Safe(
    full,
    MAX_TARGET_SESSION_AWARENESS_CHARS - suffix.length,
  ).trimEnd()}${suffix}`;
}

/** Builds the bounded one-time context injected after a heartbeat-owned send. */
export function formatHeartbeatTargetSessionAwareness(
  outcome: HeartbeatTargetSessionAwarenessOutcome,
): string {
  if (outcome.status === "failed") {
    return [
      "A heartbeat attempted to deliver a message to this channel, but delivery failed.",
      outcome.mayHaveReachedRecipient
        ? "One or more heartbeat message parts may already have been delivered."
        : "No delivery was confirmed.",
    ].join("\n");
  }
  const prefix =
    outcome.status === "delivered"
      ? "A heartbeat delivered this message to this channel:"
      : "A heartbeat attempted to deliver this message to this channel, but the channel did not confirm a delivery identity. It may have been delivered:";
  return formatBoundedTargetSessionAwareness(prefix, outcome.text);
}

const transcriptRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/transcript.runtime.js"),
);

function loadTargetSessionSnapshot(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
}): TargetSessionSnapshot {
  const entry = loadSessionEntry({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  return {
    entry,
    identity: resolveTargetSessionIdentity(entry),
    ...(entry?.delivery ? { delivery: structuredClone(entry.delivery) } : {}),
  };
}

function resolveTargetSessionIdentity(
  entry: SessionEntry | undefined,
): TargetSessionIdentity | null {
  const sessionId = normalizeOptionalString(entry?.sessionId);
  if (!sessionId) {
    return null;
  }
  const lifecycleRevision = normalizeOptionalString(entry?.lifecycleRevision);
  return {
    sessionId,
    ...(lifecycleRevision ? { lifecycleRevision } : {}),
  };
}

function sameTargetSessionIdentity(
  left: TargetSessionIdentity | null,
  right: TargetSessionIdentity | null,
): boolean {
  return (
    left?.sessionId === right?.sessionId && left?.lifecycleRevision === right?.lifecycleRevision
  );
}

function sameTargetSessionDelivery(
  left: SessionDeliveryState | undefined,
  right: SessionDeliveryState | undefined,
): boolean {
  return isDeepStrictEqual(left, right);
}

/** Captures target generation identity before background model and platform awaits. */
export function prepareTargetSessionProjection(params: {
  cfg: OpenClawConfig;
  target: AuthoritativeOutboundTargetSessionRoute;
}): PreparedTargetSessionProjection {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.target.agentId,
  });
  const observed = loadTargetSessionSnapshot({
    agentId: params.target.agentId,
    sessionKey: params.target.route.sessionKey,
    storePath,
  });
  return {
    agentId: params.target.agentId,
    route: params.target.route,
    storePath,
    isCurrent: params.target.isCurrent,
    observedSession: observed.identity,
    ...(observed.delivery ? { observedDelivery: observed.delivery } : {}),
  };
}

/** Recaptures the target generation at the irreversible-send boundary. */
export function refreshTargetSessionProjection(
  prepared: PreparedTargetSessionProjection,
): PreparedTargetSessionProjection | undefined {
  try {
    if (!prepared.isCurrent()) {
      return undefined;
    }
    const observed = loadTargetSessionSnapshot({
      agentId: prepared.agentId,
      sessionKey: prepared.route.sessionKey,
      storePath: prepared.storePath,
    });
    const { observedDelivery: _observedDelivery, ...rest } = prepared;
    return {
      ...rest,
      observedSession: observed.identity,
      ...(observed.delivery ? { observedDelivery: observed.delivery } : {}),
    };
  } catch {
    // Projection is best-effort bookkeeping; a failed refresh must not suppress
    // the recipient-visible heartbeat that has not yet crossed its send boundary.
    return undefined;
  }
}

/** Freezes the target owner and session generation before recipient-visible I/O. */
export function captureTargetSessionProjection(params: {
  cfg: OpenClawConfig;
  readCurrentConfig?: () => OpenClawConfig;
  sourceAgentId: string;
  sourceSessionKey: string;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute | null;
  coordinator?: TargetSessionProjectionCoordinator;
  idempotencyKey?: string;
}): TargetSessionProjectionSelection {
  // Same-session sends retain the ordinary message-action path. Detached
  // owner inspection may be unavailable for external plugins, but the active
  // source turn already owns this exact agent/session generation.
  if (targetsExactSourceSession(params)) {
    return { status: "ordinary" };
  }
  try {
    const authoritative = selectAuthoritativeOutboundTargetSessionRoute({
      cfg: params.cfg,
      ...(params.readCurrentConfig ? { readCurrentConfig: params.readCurrentConfig } : {}),
      sourceAgentId: params.sourceAgentId,
      channel: params.channel,
      accountId: params.accountId,
      route: params.route,
    });
    if (!authoritative) {
      return { status: "unavailable" };
    }
    if (
      authoritative.agentId === normalizeAgentId(params.sourceAgentId) &&
      authoritative.route.sessionKey === params.sourceSessionKey.trim()
    ) {
      return { status: "ordinary" };
    }
    const accountId = normalizeOptionalString(params.accountId);
    return {
      status: "captured",
      capture: {
        cfg: params.cfg,
        prepared: prepareTargetSessionProjection({ cfg: params.cfg, target: authoritative }),
        channel: params.channel,
        deliveredPayloads: [],
        idempotencyKey:
          normalizeOptionalString(params.idempotencyKey) ??
          `heartbeat-message-tool:${generateSecureUuid()}`,
        ...(params.coordinator ? { coordinator: params.coordinator } : {}),
        ...(accountId ? { accountId } : {}),
      },
    };
  } catch {
    // Delivery owns the irreversible effect. Projection failures remain best-effort.
    return { status: "unavailable" };
  }
}

function targetSessionProjectionCoordinatorKey(prepared: PreparedTargetSessionProjection): string {
  return `${prepared.agentId}\0${prepared.storePath}\0${prepared.route.sessionKey}`;
}

/**
 * Commits post-send route metadata, transcript history, and next-turn awareness.
 * The irreversible send already settled, so wake cancellation must not abandon this bookkeeping.
 */
export async function commitTargetSessionProjection(params: {
  cfg: OpenClawConfig;
  prepared: PreparedTargetSessionProjection;
  idempotencyKey: string;
  routeBinding?: { channel: ChannelId; accountId?: string };
  mirror?: { text?: string; mediaUrls?: string[] };
  awarenessText?: string;
  coordinator?: TargetSessionProjectionCoordinator;
}): Promise<TargetSessionProjectionResult> {
  const { agentId, route, storePath } = params.prepared;
  const coordinatorKey = targetSessionProjectionCoordinatorKey(params.prepared);
  let expectedSession = params.prepared.observedSession;
  const adoptCoordinatedSession = () => {
    if (!expectedSession) {
      expectedSession = params.coordinator?.sessions.get(coordinatorKey) ?? null;
    }
  };
  try {
    if (!params.prepared.isCurrent()) {
      return { status: "skipped", reason: "target conversation owner changed during delivery" };
    }
    adoptCoordinatedSession();

    const assertTargetUnchanged = (): TargetSessionSnapshot => {
      if (!params.prepared.isCurrent()) {
        throw new Error("Target conversation owner changed during delivery.");
      }
      const current = loadTargetSessionSnapshot({
        agentId,
        sessionKey: route.sessionKey,
        storePath,
      });
      if (!sameTargetSessionIdentity(expectedSession, current.identity)) {
        throw new Error(`Session "${route.sessionKey}" changed during delivery projection.`);
      }
      const unavailable = resolveSessionWorkStartError(
        route.sessionKey,
        current.entry,
        current.identity ? { expectedSessionId: current.identity.sessionId } : undefined,
      );
      if (unavailable) {
        throw new Error(unavailable);
      }
      return current;
    };

    if (!params.routeBinding && !params.mirror && !params.awarenessText) {
      return { status: "committed", warnings: [], session: expectedSession };
    }
    const identities = [route.sessionKey, expectedSession?.sessionId];

    return await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities,
      reserveAdmissionFenceWhileQueued: true,
      // The projection belongs between target turns: finish current work, then
      // keep later admissions behind route, transcript, and awareness commits.
      prepare: async () => {
        await getSessionWorkAdmissionRelease({ scope: storePath, identities });
      },
      run: async () => {
        adoptCoordinatedSession();
        const current = assertTargetUnchanged();
        if (!params.routeBinding && !expectedSession) {
          throw new Error("Target session entry is unavailable.");
        }
        // Existing conversations already own their last route. Background
        // sends refresh it only when the pre-send route is still current. A
        // newer inbound route wins while transcript and awareness still land.
        const routeStillCurrent = sameTargetSessionDelivery(
          params.prepared.observedDelivery,
          current.delivery,
        );
        if (params.routeBinding && (!expectedSession || routeStillCurrent)) {
          const expectedDelivery = current.delivery;
          try {
            await bindOutboundSessionEntry({
              cfg: params.cfg,
              agentId,
              channel: params.routeBinding.channel,
              accountId: params.routeBinding.accountId,
              route,
              assertCommitAllowed: () => {
                const latest = assertTargetUnchanged();
                if (!sameTargetSessionDelivery(expectedDelivery, latest.delivery)) {
                  throw new Error(`Session "${route.sessionKey}" route changed during delivery.`);
                }
              },
            });
          } catch (error) {
            const latest = assertTargetUnchanged();
            if (sameTargetSessionDelivery(expectedDelivery, latest.delivery)) {
              throw error;
            }
          }
          if (!expectedSession) {
            const boundSession = loadTargetSessionSnapshot({
              agentId,
              sessionKey: route.sessionKey,
              storePath,
            }).identity;
            if (!boundSession) {
              throw new Error(`Session "${route.sessionKey}" was not created by route binding.`);
            }
            expectedSession = boundSession;
            params.coordinator?.sessions.set(coordinatorKey, boundSession);
            assertTargetUnchanged();
          }
        }

        const warnings: string[] = [];
        if (params.mirror && !expectedSession) {
          warnings.push("transcript: target session entry is unavailable");
        } else if (params.mirror && expectedSession) {
          try {
            const { appendAssistantMessageToSessionTranscript } =
              await transcriptRuntimeLoader.load();
            const transcript = await appendAssistantMessageToSessionTranscript({
              agentId,
              sessionKey: route.sessionKey,
              expectedSessionId: expectedSession.sessionId,
              ...(expectedSession.lifecycleRevision
                ? { expectedLifecycleRevision: expectedSession.lifecycleRevision }
                : {}),
              ...params.mirror,
              idempotencyKey: params.idempotencyKey,
              storePath,
              config: params.cfg,
              beforeMessageWrite: ({ message }) => (params.prepared.isCurrent() ? message : null),
            });
            if (!transcript.ok) {
              if (!params.prepared.isCurrent()) {
                throw new Error("Target conversation owner changed during transcript projection.");
              }
              warnings.push(`transcript: ${transcript.reason}`);
            }
          } catch (error) {
            if (!params.prepared.isCurrent()) {
              throw error;
            }
            warnings.push(`transcript: ${formatErrorMessage(error)}`);
          }
        }
        // Enqueue last: a bounded queue may evict an older event, which cannot
        // be rolled back if route or transcript bookkeeping later fails. The
        // active lifecycle mutation still keeps newer turns behind this fact.
        if (params.awarenessText) {
          assertTargetUnchanged();
          enqueueSystemEventDeferredDuringHeartbeat(
            params.awarenessText,
            withSystemEventOwner(
              {
                sessionKey: route.sessionKey,
                contextKey: params.idempotencyKey,
              },
              agentId,
            ),
          );
        }
        if (expectedSession) {
          params.coordinator?.sessions.set(coordinatorKey, expectedSession);
        }
        return { status: "committed", warnings, session: expectedSession };
      },
    });
  } catch (error) {
    return { status: "skipped", reason: formatErrorMessage(error) };
  }
}

function beginCapturedHeartbeatProjection(params: {
  capture: TargetSessionProjectionCapture | undefined;
  partialDelivery?: boolean;
  routeOnly?: boolean;
}): void {
  const capture = params.capture;
  if (!capture || capture.completion) {
    return;
  }
  const coordinator = capture.coordinator;

  const mirrorPayload =
    !params.routeOnly && capture.deliveredPayloads.length > 0
      ? projectDeliveredOutboundPayloadsForMirror(capture.deliveredPayloads)
      : undefined;
  const mirror =
    mirrorPayload && (normalizeOptionalString(mirrorPayload.text) || mirrorPayload.mediaUrls.length)
      ? {
          ...(normalizeOptionalString(mirrorPayload.text) ? { text: mirrorPayload.text } : {}),
          ...(mirrorPayload.mediaUrls.length ? { mediaUrls: mirrorPayload.mediaUrls } : {}),
        }
      : undefined;
  const awarenessText = params.routeOnly
    ? undefined
    : params.partialDelivery
      ? formatHeartbeatTargetSessionAwareness({
          status: "failed",
          mayHaveReachedRecipient: true,
        })
      : formatHeartbeatTargetSessionAwareness({
          status: "delivered",
          text: resolveMirroredTranscriptText(mirror ?? {}) ?? undefined,
        });
  const project = async (): Promise<TargetSessionProjectionCompletion> => {
    const prepared = capture.prepared;
    const result = await commitTargetSessionProjection({
      cfg: capture.cfg,
      prepared,
      idempotencyKey: capture.idempotencyKey,
      routeBinding: {
        channel: capture.channel,
        ...(capture.accountId ? { accountId: capture.accountId } : {}),
      },
      ...(mirror ? { mirror } : {}),
      ...(awarenessText ? { awarenessText } : {}),
      ...(coordinator ? { coordinator } : {}),
    });
    if (result.status === "skipped" || !result.session) {
      return { status: "skipped", warnings: 0 };
    }
    const committed = { ...prepared, observedSession: result.session };
    capture.prepared = committed;
    return { status: "committed", warnings: result.warnings.length };
  };

  // Each confirmed send queues its mutation synchronously. Same-target
  // mutations therefore remain contiguous ahead of later turn admissions.
  const projection = project();
  const completion = projection.catch(() => {
    return { status: "skipped" as const, warnings: 0 };
  });
  capture.completion = completion;
  coordinator?.completions.add(completion);
}

/** Starts heartbeat message-tool projection at the confirmed action boundary. */
export function beginCapturedHeartbeatMessageToolProjection(params: {
  capture: TargetSessionProjectionCapture | undefined;
  partialDelivery: boolean;
}): void {
  beginCapturedHeartbeatProjection(params);
}

/** Preserves only the target route when a plugin returns opaque acceptance. */
export function beginCapturedHeartbeatOpaquePluginRouteProjection(
  capture: TargetSessionProjectionCapture | undefined,
): void {
  beginCapturedHeartbeatProjection({ capture, routeOnly: true });
}

export type HeartbeatMessageToolProjectionSummary = {
  projected: number;
  skipped: number;
  warnings: number;
};

/** Waits for projections started by confirmed core message-tool actions. */
export async function projectHeartbeatMessageToolDeliveries(params: {
  coordinator: TargetSessionProjectionCoordinator;
}): Promise<HeartbeatMessageToolProjectionSummary> {
  const summary: HeartbeatMessageToolProjectionSummary = {
    projected: 0,
    skipped: 0,
    warnings: 0,
  };
  const completions: readonly Promise<TargetSessionProjectionCompletion>[] = [
    ...params.coordinator.completions,
  ];
  for (const completion of completions) {
    try {
      const result = await completion;
      if (result.status === "skipped") {
        summary.skipped += 1;
      } else {
        summary.projected += 1;
        summary.warnings += result.warnings;
      }
    } catch {
      summary.skipped += 1;
    }
  }
  return summary;
}
