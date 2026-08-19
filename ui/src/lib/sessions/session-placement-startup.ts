import type {
  SessionPlacement,
  SessionsDispatchResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { SessionPlacementTarget } from "./session-placement-recovery.ts";

type SessionPlacementStartOutcome =
  | { status: "started"; messageId: string; messageSeq?: number }
  | { status: "cancelled" }
  | { status: "interrupted" }
  | { status: "cleanup-rejected"; error: string; messageId?: string }
  | { status: "dispatch-rejected"; error: string }
  | { status: "session-missing"; error: string }
  | { status: "send-not-started"; error: string }
  | { status: "send-definitive-rejected"; error: string; messageId: string }
  | { status: "send-rejected"; error: string; messageId: string };

type PlacementReadResult =
  | { status: "read"; placement?: SessionPlacement; sessionId?: string }
  | { status: "missing" }
  | { status: "rejected"; error: string }
  | { status: "unavailable" };
type PlacementResolution =
  | { status: "active"; placement: SessionPlacement }
  | { status: "cancelled" }
  | { status: "interrupted" }
  | { status: "cleanup-rejected"; error: string }
  | { status: "missing" }
  | { status: "rejected"; placement?: SessionPlacement };
const DISPATCH_RECONCILE_INTERVAL_MS = 250;
const DISPATCH_RECONCILE_ATTEMPTS = 1_200;
const PLACEMENT_LOOKUP_FAILURE_LIMIT = 4;
const EMPTY_PLACEMENT_LIMIT = 20;
const PENDING_PLACEMENT_STATES = new Set([
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "draining",
  "reconciling",
]);

function isAmbiguousDispatchError(error: unknown): boolean {
  if (error instanceof GatewayRequestError) {
    return error.retryable || error.gatewayCode === "UNAVAILABLE";
  }
  return true;
}

async function readPlacement(
  client: Pick<GatewayBrowserClient, "request">,
  key: string,
): Promise<PlacementReadResult> {
  try {
    const described = await client.request<{
      session?: { placement?: SessionPlacement; sessionId?: string } | null;
    }>("sessions.describe", { key });
    if (described?.session === null) {
      return { status: "missing" };
    }
    const sessionId = described?.session?.sessionId;
    return {
      status: "read",
      placement: described?.session?.placement,
      ...(typeof sessionId === "string" && sessionId.trim() ? { sessionId } : {}),
    };
  } catch (error) {
    if (!isAmbiguousDispatchError(error)) {
      return {
        status: "rejected",
        error: formatUiError(error),
      };
    }
    return { status: "unavailable" };
  }
}

async function reclaimSessionPlacement(
  client: Pick<GatewayBrowserClient, "request">,
  params: { key: string; agentId: string; abortRun: boolean },
): Promise<string | undefined> {
  if (params.abortRun) {
    await client
      .request("sessions.abort", { key: params.key, agentId: params.agentId })
      .catch(() => undefined);
  }
  try {
    await client.request("sessions.reclaim", { key: params.key, agentId: params.agentId });
    return undefined;
  } catch (error) {
    return formatUiError(error);
  }
}

async function resolveActivePlacement(
  client: Pick<GatewayBrowserClient, "request">,
  params: {
    key: string;
    agentId: string;
    initial?: SessionPlacement;
    cleanupOnCancellation: boolean;
  },
  isCurrent: () => boolean,
): Promise<PlacementResolution> {
  let next = params.initial ? ({ status: "read", placement: params.initial } as const) : undefined;
  let lookupFailures = 0;
  let emptyPlacements = 0;
  for (let attempt = 0; attempt < DISPATCH_RECONCILE_ATTEMPTS; attempt += 1) {
    const result = next ?? (await readPlacement(client, params.key));
    next = undefined;
    if (result.status === "missing") {
      return { status: "missing" };
    }
    if (result.status === "rejected") {
      return { status: "cleanup-rejected", error: result.error };
    }
    if (result.status === "unavailable") {
      lookupFailures += 1;
      const submissionCancelled = !isCurrent();
      if (submissionCancelled || lookupFailures >= PLACEMENT_LOOKUP_FAILURE_LIMIT) {
        if (!params.cleanupOnCancellation && submissionCancelled) {
          return { status: "interrupted" };
        }
        const cleanupError = await reclaimSessionPlacement(client, {
          key: params.key,
          agentId: params.agentId,
          abortRun: false,
        });
        if (submissionCancelled) {
          return cleanupError
            ? { status: "cleanup-rejected", error: cleanupError }
            : { status: "cancelled" };
        }
        const placementError = "cloud worker placement could not be verified";
        return {
          status: "cleanup-rejected",
          error: cleanupError
            ? `${placementError}; cleanup failed: ${cleanupError}`
            : placementError,
        };
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, DISPATCH_RECONCILE_INTERVAL_MS);
      });
      continue;
    }
    lookupFailures = 0;
    if (result.status === "read") {
      const placement = result.placement;
      if (!placement) {
        emptyPlacements += 1;
        if (emptyPlacements >= EMPTY_PLACEMENT_LIMIT) {
          return {
            status: "cleanup-rejected",
            error: "cloud worker placement could not be verified",
          };
        }
      } else {
        emptyPlacements = 0;
      }
      if (!isCurrent()) {
        if (!params.cleanupOnCancellation) {
          return { status: "interrupted" };
        }
        const cleanupError = await reclaimSessionPlacement(client, {
          key: params.key,
          agentId: params.agentId,
          abortRun: false,
        });
        return cleanupError
          ? { status: "cleanup-rejected", error: cleanupError }
          : { status: "cancelled" };
      } else if (placement?.state === "active") {
        return { status: "active", placement };
      } else if (placement && !PENDING_PLACEMENT_STATES.has(placement.state)) {
        if (placement.state === "failed") {
          const cleanupError = await reclaimSessionPlacement(client, {
            key: params.key,
            agentId: params.agentId,
            abortRun: false,
          });
          if (cleanupError) {
            return { status: "cleanup-rejected", error: cleanupError };
          }
        }
        return { status: "rejected", placement };
      }
    }
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, DISPATCH_RECONCILE_INTERVAL_MS);
    });
  }
  if (!params.cleanupOnCancellation && !isCurrent()) {
    return { status: "interrupted" };
  }
  if (!isCurrent()) {
    const cleanupError = await reclaimSessionPlacement(client, {
      key: params.key,
      agentId: params.agentId,
      abortRun: false,
    });
    return cleanupError
      ? { status: "cleanup-rejected", error: cleanupError }
      : { status: "cancelled" };
  }
  return {
    status: "cleanup-rejected",
    error: isCurrent()
      ? "cloud worker placement reconciliation timed out"
      : "cloud worker cleanup timed out",
  };
}

export async function deleteSessionPlacementDraft(
  client: Pick<GatewayBrowserClient, "request"> | null,
  key: string,
  agentId: string,
): Promise<string | undefined> {
  if (!client) {
    return "gateway unavailable during draft cleanup";
  }
  const existing = await readPlacement(client, key);
  if (existing.status === "missing") {
    return undefined;
  }
  if (existing.status === "rejected") {
    return existing.error;
  }
  if (existing.status === "unavailable") {
    return "cloud draft session could not be verified";
  }
  if (!existing.sessionId) {
    return "cloud draft session identity is unavailable";
  }
  return archiveAndDeleteSessionPlacementDraft(client, {
    key,
    agentId,
    sessionId: existing.sessionId,
  });
}

async function archiveAndDeleteSessionPlacementDraft(
  client: Pick<GatewayBrowserClient, "request">,
  params: { key: string; agentId: string; sessionId: string },
): Promise<string | undefined> {
  try {
    await client.request("sessions.patch", {
      key: params.key,
      agentId: params.agentId,
      archived: true,
      expectedSessionId: params.sessionId,
    });
  } catch (error) {
    return formatUiError(error);
  }
  try {
    const deleted = await client.request<{ deleted?: boolean }>("sessions.delete", {
      key: params.key,
      agentId: params.agentId,
      deleteTranscript: true,
      expectedSessionId: params.sessionId,
      archivedOnly: true,
    });
    if (deleted.deleted !== true) {
      throw new Error("cloud draft session was not deleted");
    }
    return undefined;
  } catch (error) {
    const deleteError = formatUiError(error);
    try {
      await client.request("sessions.patch", {
        key: params.key,
        agentId: params.agentId,
        archived: false,
        expectedSessionId: params.sessionId,
      });
    } catch (restoreError) {
      return `${deleteError}; restoring the cloud draft failed: ${formatUiError(restoreError)}`;
    }
    return deleteError;
  }
}

export async function deleteRecoveredSessionPlacementDraft(
  client: Pick<GatewayBrowserClient, "request"> | null,
  key: string,
  agentId: string,
): Promise<string | undefined> {
  if (!client) {
    return "gateway unavailable during draft cleanup";
  }
  const existing = await readPlacement(client, key);
  if (existing.status === "missing") {
    return undefined;
  }
  if (existing.status === "rejected") {
    return existing.error;
  }
  if (existing.status === "unavailable") {
    return "cloud worker placement could not be verified";
  }
  if (existing.placement) {
    const cleanupError = await reclaimSessionPlacement(client, { key, agentId, abortRun: false });
    if (cleanupError) {
      return cleanupError;
    }
  }
  if (!existing.sessionId) {
    return "cloud draft session identity is unavailable";
  }
  return archiveAndDeleteSessionPlacementDraft(client, {
    key,
    agentId,
    sessionId: existing.sessionId,
  });
}

export async function startSessionPlacementInitialTurn(
  client: Pick<GatewayBrowserClient, "request">,
  params: {
    key: string;
    agentId: string;
    target: SessionPlacementTarget;
    message: string;
    attachments?: unknown[];
    messageId?: string;
    recovering?: boolean;
    retryTerminalPlacement?: boolean;
    cleanupOnCancellation?: boolean;
  },
  isCurrent: () => boolean,
  beforeSend: () => boolean = () => true,
): Promise<SessionPlacementStartOutcome> {
  const cleanupOnCancellation = params.cleanupOnCancellation !== false;
  let resolution: PlacementResolution | undefined;
  let dispatchError = "";
  if (params.recovering) {
    const existing = await readPlacement(client, params.key);
    if (existing.status === "missing") {
      resolution = { status: "missing" };
    } else if (existing.status === "rejected") {
      resolution = { status: "cleanup-rejected", error: existing.error };
    } else if (existing.status === "unavailable" || existing.placement) {
      resolution = await resolveActivePlacement(
        client,
        {
          key: params.key,
          agentId: params.agentId,
          initial: existing.status === "read" ? existing.placement : undefined,
          cleanupOnCancellation,
        },
        isCurrent,
      );
    }
    if (params.retryTerminalPlacement && resolution?.status === "rejected") {
      // A previous first-turn request was durable but its worker is terminal.
      // Redispatch and reuse the same message key so an accepted send cannot duplicate work.
      resolution = undefined;
    }
  }
  if (!resolution) {
    const dispatchTarget =
      params.target.kind === "profile"
        ? {
            profileId: params.target.profileId,
            ...(params.target.machineClass ? { machineClass: params.target.machineClass } : {}),
          }
        : { deviceId: params.target.deviceId };
    try {
      const dispatched = await client.request<SessionsDispatchResult>("sessions.dispatch", {
        key: params.key,
        agentId: params.agentId,
        ...dispatchTarget,
      });
      resolution = await resolveActivePlacement(
        client,
        {
          key: params.key,
          agentId: params.agentId,
          initial: dispatched.placement,
          cleanupOnCancellation,
        },
        isCurrent,
      );
    } catch (error) {
      dispatchError = formatUiError(error);
      if (!cleanupOnCancellation && !isCurrent()) {
        return { status: "interrupted" };
      }
      if (!isAmbiguousDispatchError(error)) {
        return { status: "dispatch-rejected", error: dispatchError };
      }
      resolution = await resolveActivePlacement(
        client,
        { key: params.key, agentId: params.agentId, cleanupOnCancellation },
        isCurrent,
      );
    }
  }
  if (!cleanupOnCancellation && !isCurrent()) {
    return { status: "interrupted" };
  }
  if (
    resolution.status === "cancelled" ||
    resolution.status === "interrupted" ||
    resolution.status === "cleanup-rejected"
  ) {
    return resolution;
  }
  if (resolution.status === "missing") {
    return { status: "session-missing", error: "cloud draft session no longer exists" };
  }
  if (resolution.status === "rejected") {
    const state = typeof resolution.placement?.state === "string" ? resolution.placement.state : "";
    return {
      status: "dispatch-rejected",
      error: dispatchError || (state ? `cloud worker placement became ${state}` : ""),
    };
  }
  if (!isCurrent()) {
    if (!cleanupOnCancellation) {
      return { status: "interrupted" };
    }
    const cleanupError = await reclaimSessionPlacement(client, {
      key: params.key,
      agentId: params.agentId,
      abortRun: false,
    });
    if (cleanupError) {
      return { status: "cleanup-rejected", error: cleanupError };
    }
    return { status: "cancelled" };
  }
  const messageId = params.messageId ?? generateUUID();
  if (!beforeSend()) {
    const cleanupError = await reclaimSessionPlacement(client, {
      key: params.key,
      agentId: params.agentId,
      abortRun: false,
    });
    return cleanupError
      ? { status: "cleanup-rejected", error: cleanupError }
      : { status: "send-not-started", error: "cloud recovery storage is unavailable" };
  }
  try {
    const sent = await client.request<{ messageSeq?: unknown }>("sessions.send", {
      key: params.key,
      agentId: params.agentId,
      message: params.message,
      attachments: params.attachments,
      idempotencyKey: messageId,
    });
    if (!isCurrent()) {
      if (!cleanupOnCancellation) {
        return { status: "interrupted" };
      }
      const cleanupError = await reclaimSessionPlacement(client, {
        key: params.key,
        agentId: params.agentId,
        abortRun: true,
      });
      return cleanupError
        ? { status: "cleanup-rejected", error: cleanupError, messageId }
        : { status: "cancelled" };
    }
    const messageSeq = sent?.messageSeq;
    return {
      status: "started",
      messageId,
      ...(typeof messageSeq === "number" && Number.isSafeInteger(messageSeq) && messageSeq > 0
        ? { messageSeq }
        : {}),
    };
  } catch (error) {
    if (!isCurrent()) {
      if (!cleanupOnCancellation) {
        return { status: "interrupted" };
      }
      const cleanupError = await reclaimSessionPlacement(client, {
        key: params.key,
        agentId: params.agentId,
        abortRun: true,
      });
      return cleanupError
        ? { status: "cleanup-rejected", error: cleanupError, messageId }
        : { status: "cancelled" };
    }
    if (!isAmbiguousDispatchError(error)) {
      const cleanupError = await reclaimSessionPlacement(client, {
        key: params.key,
        agentId: params.agentId,
        abortRun: false,
      });
      return cleanupError
        ? { status: "cleanup-rejected", error: cleanupError, messageId }
        : {
            status: "send-definitive-rejected",
            error: formatUiError(error),
            messageId,
          };
    }
    return {
      status: "send-rejected",
      error: formatUiError(error),
      messageId,
    };
  }
}
