import type {
  SessionPlacement,
  SessionsDispatchResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";

type CloudStartOutcome =
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
  | { status: "read"; placement?: SessionPlacement }
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
      session?: { placement?: SessionPlacement } | null;
    }>("sessions.describe", { key });
    if (described?.session === null) {
      return { status: "missing" };
    }
    return { status: "read", placement: described?.session?.placement };
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

function placementEnvironmentId(placement: SessionPlacement | undefined): string | undefined {
  if (!placement || !("environmentId" in placement)) {
    return undefined;
  }
  const environmentId = placement.environmentId;
  return typeof environmentId === "string" && environmentId.trim() ? environmentId : undefined;
}

async function cancelActivePlacement(
  client: Pick<GatewayBrowserClient, "request">,
  params: { key: string; agentId: string; environmentId: unknown; abortRun: boolean },
): Promise<string | undefined> {
  if (params.abortRun) {
    // Stop accepted inference first. Destroying the worker is the hard safety
    // boundary when the abort response is lost or the run has not registered yet.
    await client
      .request("sessions.abort", { key: params.key, agentId: params.agentId })
      .catch(() => undefined);
  }
  const environmentId = params.environmentId;
  if (typeof environmentId !== "string" || !environmentId.trim()) {
    return "cloud worker cleanup lost its environment identity";
  }
  try {
    await client.request("environments.destroy", { environmentId });
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
  let lastKnownEnvironmentId = placementEnvironmentId(params.initial);
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
        if (lastKnownEnvironmentId) {
          // The last successful placement read still proves worker ownership.
          // Destroy it before returning, or a lookup outage can orphan paid capacity.
          const cleanupError = await cancelActivePlacement(client, {
            key: params.key,
            agentId: params.agentId,
            environmentId: lastKnownEnvironmentId,
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
        return {
          status: "cleanup-rejected",
          error: "cloud worker placement could not be verified",
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
      if (placement) {
        const environmentId = placementEnvironmentId(placement);
        if (environmentId) {
          lastKnownEnvironmentId = environmentId;
        }
      }
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
        const cleanupEnvironmentId = placementEnvironmentId(placement) ?? lastKnownEnvironmentId;
        if (cleanupEnvironmentId) {
          const cleanupError = await cancelActivePlacement(client, {
            key: params.key,
            agentId: params.agentId,
            environmentId: cleanupEnvironmentId,
            abortRun: false,
          });
          return cleanupError
            ? { status: "cleanup-rejected", error: cleanupError }
            : { status: "cancelled" };
        }
        if (placement?.state === "active") {
          return {
            status: "cleanup-rejected",
            error: "cloud worker cleanup lost its environment identity",
          };
        }
        if (placement && !PENDING_PLACEMENT_STATES.has(placement.state)) {
          return { status: "cancelled" };
        }
      } else if (placement?.state === "active") {
        return { status: "active", placement };
      } else if (placement && !PENDING_PLACEMENT_STATES.has(placement.state)) {
        if (lastKnownEnvironmentId) {
          // A terminal provisioning failure may still own an allocated worker.
          // Tear it down before the draft session and its recovery record vanish.
          const cleanupError = await cancelActivePlacement(client, {
            key: params.key,
            agentId: params.agentId,
            environmentId: lastKnownEnvironmentId,
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
  return {
    status: "cleanup-rejected",
    error: isCurrent()
      ? "cloud worker placement reconciliation timed out"
      : "cloud worker cleanup timed out",
  };
}

export async function deleteCloudDraftSession(
  client: Pick<GatewayBrowserClient, "request"> | null,
  key: string,
  agentId: string,
): Promise<string | undefined> {
  if (!client) {
    return "gateway unavailable during draft cleanup";
  }
  try {
    await client.request("sessions.delete", { key, agentId, deleteTranscript: true });
    return undefined;
  } catch (error) {
    return formatUiError(error);
  }
}

export async function deleteRecoveredCloudDraftSession(
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
    // Recovery can resume after dispatch. Destroy that placement before its
    // durable session identity is removed, or the worker becomes untrackable.
    const resolution = await resolveActivePlacement(
      client,
      { key, agentId, initial: existing.placement, cleanupOnCancellation: true },
      () => false,
    );
    if (resolution.status === "cleanup-rejected") {
      return resolution.error;
    }
    if (resolution.status === "active") {
      return "cloud worker cleanup did not cancel its active placement";
    }
  }
  // sessions.delete shares the server lifecycle barrier that starts dispatch.
  // If placement is still invisible, deletion wins first or observes it under that lock.
  return deleteCloudDraftSession(client, key, agentId);
}

export async function startCloudInitialTurn(
  client: Pick<GatewayBrowserClient, "request">,
  params: {
    key: string;
    agentId: string;
    profileId: string;
    machineClass?: string;
    message: string;
    attachments?: unknown[];
    messageId?: string;
    recovering?: boolean;
    retryTerminalPlacement?: boolean;
    cleanupOnCancellation?: boolean;
  },
  isCurrent: () => boolean,
  beforeSend: () => boolean = () => true,
): Promise<CloudStartOutcome> {
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
    try {
      const dispatched = await client.request<SessionsDispatchResult>("sessions.dispatch", {
        key: params.key,
        agentId: params.agentId,
        profileId: params.profileId,
        ...(params.machineClass ? { machineClass: params.machineClass } : {}),
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
  const placement = resolution.placement;
  if (!isCurrent()) {
    if (!cleanupOnCancellation) {
      return { status: "interrupted" };
    }
    const cleanupError = await cancelActivePlacement(client, {
      key: params.key,
      agentId: params.agentId,
      environmentId: placementEnvironmentId(placement),
      abortRun: false,
    });
    if (cleanupError) {
      return { status: "cleanup-rejected", error: cleanupError };
    }
    return { status: "cancelled" };
  }
  const messageId = params.messageId ?? generateUUID();
  if (!beforeSend()) {
    const cleanupError = await cancelActivePlacement(client, {
      key: params.key,
      agentId: params.agentId,
      environmentId: placementEnvironmentId(placement),
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
      const cleanupError = await cancelActivePlacement(client, {
        key: params.key,
        agentId: params.agentId,
        environmentId: placementEnvironmentId(placement),
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
      const cleanupError = await cancelActivePlacement(client, {
        key: params.key,
        agentId: params.agentId,
        environmentId: placementEnvironmentId(placement),
        abortRun: true,
      });
      return cleanupError
        ? { status: "cleanup-rejected", error: cleanupError, messageId }
        : { status: "cancelled" };
    }
    if (!isAmbiguousDispatchError(error)) {
      const cleanupError = await cancelActivePlacement(client, {
        key: params.key,
        agentId: params.agentId,
        environmentId: placementEnvironmentId(placement),
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
