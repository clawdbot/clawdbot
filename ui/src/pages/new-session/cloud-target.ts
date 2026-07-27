import { html, nothing } from "lit";
import type {
  EnvironmentsListResult,
  SessionsDispatchResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { readDraftCloudProfiles } from "./discovery.ts";

type CloudStartOutcome =
  | { status: "started"; messageId: string; messageSeq?: number }
  | { status: "cancelled" }
  | { status: "cleanup-rejected"; error: string; messageId?: string }
  | { status: "dispatch-rejected"; error: string }
  | { status: "session-missing"; error: string }
  | { status: "send-not-started"; error: string }
  | { status: "send-definitive-rejected"; error: string; messageId: string }
  | { status: "send-rejected"; error: string; messageId: string };

type PlacementSnapshot = { state?: unknown; environmentId?: unknown };
type PlacementReadResult =
  | { status: "read"; placement?: PlacementSnapshot }
  | { status: "missing" }
  | { status: "rejected"; error: string }
  | { status: "unavailable" };
type PlacementResolution =
  | { status: "active"; placement: PlacementSnapshot }
  | { status: "cancelled" }
  | { status: "cleanup-rejected"; error: string }
  | { status: "missing" }
  | { status: "rejected"; placement?: PlacementSnapshot };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
      session?: { placement?: PlacementSnapshot } | null;
    }>("sessions.describe", { key });
    if (described?.session === null) {
      return { status: "missing" };
    }
    return { status: "read", placement: described?.session?.placement };
  } catch (error) {
    if (!isAmbiguousDispatchError(error)) {
      return { status: "rejected", error: errorMessage(error) };
    }
    return { status: "unavailable" };
  }
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
    return errorMessage(error);
  }
}

async function resolveActivePlacement(
  client: Pick<GatewayBrowserClient, "request">,
  params: { key: string; agentId: string; initial?: PlacementSnapshot },
  isCurrent: () => boolean,
): Promise<PlacementResolution> {
  let next = params.initial ? ({ status: "read", placement: params.initial } as const) : undefined;
  let lastKnownEnvironmentId =
    typeof params.initial?.environmentId === "string" && params.initial.environmentId.trim()
      ? params.initial.environmentId
      : undefined;
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
      if (!isCurrent() || lookupFailures >= PLACEMENT_LOOKUP_FAILURE_LIMIT) {
        if (!isCurrent() && lastKnownEnvironmentId) {
          const cleanupError = await cancelActivePlacement(client, {
            key: params.key,
            agentId: params.agentId,
            environmentId: lastKnownEnvironmentId,
            abortRun: false,
          });
          return cleanupError
            ? { status: "cleanup-rejected", error: cleanupError }
            : { status: "cancelled" };
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
        if (typeof placement.environmentId === "string" && placement.environmentId.trim()) {
          lastKnownEnvironmentId = placement.environmentId;
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
        const cleanupEnvironmentId =
          typeof placement?.environmentId === "string" && placement.environmentId.trim()
            ? placement.environmentId
            : lastKnownEnvironmentId;
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
        if (placement && !PENDING_PLACEMENT_STATES.has(String(placement.state))) {
          return { status: "cancelled" };
        }
      } else if (placement?.state === "active") {
        return { status: "active", placement };
      } else if (placement && !PENDING_PLACEMENT_STATES.has(String(placement.state))) {
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
    return errorMessage(error);
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
      { key, agentId, initial: existing.placement },
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

export async function requestCloudProfiles(
  client: Pick<GatewayBrowserClient, "request">,
): Promise<DraftCloudProfile[]> {
  const result = await client.request<EnvironmentsListResult>("environments.list", {});
  return readDraftCloudProfiles(result?.profiles);
}

export async function startCloudInitialTurn(
  client: Pick<GatewayBrowserClient, "request">,
  params: {
    key: string;
    agentId: string;
    profileId: string;
    message: string;
    attachments?: unknown[];
    messageId?: string;
    recovering?: boolean;
    retryTerminalPlacement?: boolean;
  },
  isCurrent: () => boolean,
  beforeSend: () => boolean = () => true,
): Promise<CloudStartOutcome> {
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
      });
      resolution = await resolveActivePlacement(
        client,
        { key: params.key, agentId: params.agentId, initial: dispatched.placement },
        isCurrent,
      );
    } catch (error) {
      dispatchError = errorMessage(error);
      if (!isAmbiguousDispatchError(error)) {
        return { status: "dispatch-rejected", error: dispatchError };
      }
      resolution = await resolveActivePlacement(
        client,
        { key: params.key, agentId: params.agentId },
        isCurrent,
      );
    }
  }
  if (resolution.status === "cancelled" || resolution.status === "cleanup-rejected") {
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
    const cleanupError = await cancelActivePlacement(client, {
      key: params.key,
      agentId: params.agentId,
      environmentId: placement.environmentId,
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
      environmentId: placement.environmentId,
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
      const cleanupError = await cancelActivePlacement(client, {
        key: params.key,
        agentId: params.agentId,
        environmentId: placement?.environmentId,
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
      const cleanupError = await cancelActivePlacement(client, {
        key: params.key,
        agentId: params.agentId,
        environmentId: placement?.environmentId,
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
        environmentId: placement.environmentId,
        abortRun: false,
      });
      return cleanupError
        ? { status: "cleanup-rejected", error: cleanupError, messageId }
        : { status: "send-definitive-rejected", error: errorMessage(error), messageId };
    }
    return { status: "send-rejected", error: errorMessage(error), messageId };
  }
}

type SessionMenuItemOptions = {
  value: string;
  label: string;
  icon?: unknown;
  sub?: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  keepOpen?: boolean;
  onSelect: () => void;
};

export function renderSessionMenuItem(params: SessionMenuItemOptions, submitting: boolean) {
  return html`
    <button
      type="button"
      class="session-menu__item"
      data-value=${params.value}
      data-popover=${params.keepOpen ? nothing : "close"}
      aria-pressed=${String(params.checked)}
      title=${params.title ?? nothing}
      ?disabled=${submitting || (params.disabled ?? false)}
      @click=${params.onSelect}
    >
      <span class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
      ${params.icon
        ? html`<span class="session-menu__icon" aria-hidden="true">${params.icon}</span>`
        : nothing}
      <span class="session-menu__text">${params.label}</span>
      ${params.sub ? html`<span class="session-menu__sub">${params.sub}</span>` : nothing}
    </button>
  `;
}

export function renderCloudProfileMenuItems(params: {
  profiles: DraftCloudProfile[];
  selectedId: string;
  submitting: boolean;
  icon?: unknown;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: (profileId: string) => void;
}) {
  return params.profiles.map((profile) =>
    renderSessionMenuItem(
      {
        value: `cloud:${profile.id}`,
        label: t("newSession.cloudWorker", { profile: profile.id }),
        icon: params.icon,
        checked: params.selectedId === profile.id,
        disabled: params.disabled,
        title:
          params.disabled && params.disabledReason
            ? params.disabledReason
            : t("newSession.cloudWorkerProvider", { provider: profile.providerId }),
        onSelect: () => params.onSelect(profile.id),
      },
      params.submitting,
    ),
  );
}
