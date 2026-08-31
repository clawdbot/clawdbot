import { normalizeAccountId } from "../../routing/session-key.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../../secrets/runtime-degraded-state.js";
import type { ChannelAccountLinkState } from "../plugins/types.adapters.js";
import type {
  ChannelAccountSnapshot,
  ChannelAccountState as ChannelAccountDisplayState,
} from "../plugins/types.core.js";

// Internal to this module: callers consume the projections, never the variant
// shape. Keeping it unexported also avoids colliding with the display-state
// `ChannelAccountState` in plugins/types.core.ts.
type ChannelAccountState =
  | {
      kind: "disabled";
      configured: boolean;
      linked: boolean | undefined;
      reason: string;
      failure: string | null;
    }
  | { kind: "unconfigured"; reason: string; failure: string | null }
  | { kind: "unlinked"; reason: string; failure: string | null }
  | { kind: "running"; linked?: true; connected?: boolean; failure: string | null }
  | { kind: "stopped"; linked?: true; connected?: boolean; failure: string | null };

type ChannelAccountStateInput = {
  enabled: boolean;
  configured: boolean;
  linked: boolean | undefined;
  runtime?: Pick<ChannelAccountSnapshot, "running" | "connected" | "lastError">;
  disabledReason?: string;
  unconfiguredReason?: string;
  unlinkedReason?: string;
};

export function resolveUnavailableChannelAccountSnapshot(params: {
  channelId: string;
  accountId: string;
  runtime?: ChannelAccountSnapshot;
}): ChannelAccountSnapshot | undefined {
  const owner = findActiveDegradedSecretOwner(
    "account",
    `${params.channelId}:${normalizeAccountId(params.accountId)}`,
  );
  if (!owner) {
    return undefined;
  }
  // Cold owners have no operational account to resolve or probe. Stale owners
  // retain usable credentials and are excluded by the secrets runtime lookup.
  const lastError = new SecretSurfaceUnavailableError(owner).message;
  return {
    ...params.runtime,
    accountId: params.accountId,
    enabled: params.runtime?.enabled ?? true,
    configured: true,
    running: false,
    ...(typeof params.runtime?.connected === "boolean" ? { connected: false } : {}),
    restartPending: false,
    lifecycle: "blocked",
    stateReason: lastError,
    lastError,
  };
}

function assertNeverState(state: never): never {
  throw new Error(`Unhandled channel account state: ${String(state)}`);
}

export function resolveChannelAccountState(input: ChannelAccountStateInput): ChannelAccountState {
  const failure = input.runtime?.lastError ?? null;
  if (!input.enabled) {
    return {
      kind: "disabled",
      configured: input.configured,
      linked: input.linked,
      reason: input.disabledReason ?? "disabled",
      failure,
    };
  }
  if (!input.configured) {
    return {
      kind: "unconfigured",
      reason: input.unconfiguredReason ?? "not configured",
      failure,
    };
  }
  if (input.linked === false) {
    return { kind: "unlinked", reason: input.unlinkedReason ?? "not linked", failure };
  }
  if (input.runtime?.running === true) {
    return {
      kind: "running",
      linked: input.linked,
      // Connectivity is tri-state: absent means the transport publishes none at
      // all (imessage, signal, sms, ...), which is not a reported disconnect.
      // Defaulting to false makes `evaluateChannelHealth` return "disconnected"
      // and the health monitor restart every socketless channel per cooldown.
      connected: input.runtime.connected,
      failure,
    };
  }
  return {
    kind: "stopped",
    linked: input.linked,
    connected: input.runtime?.connected,
    failure,
  };
}

export function resolveChannelAccountLinked(
  state: ChannelAccountLinkState | undefined,
  fallback?: boolean,
): boolean | undefined {
  return state ? (state === "unknown" ? undefined : state === "linked") : fallback;
}

function projectChannelAccountState(state: ChannelAccountState): {
  configured: boolean;
  linked?: boolean;
  running: boolean;
  connected?: boolean;
  stateReason?: string;
  lastError: string | null;
} {
  switch (state.kind) {
    case "disabled":
      return {
        configured: state.configured,
        ...(typeof state.linked === "boolean" ? { linked: state.linked } : {}),
        running: false,
        stateReason: state.reason,
        lastError: state.failure,
      };
    case "unconfigured":
    case "unlinked":
      return {
        configured: state.kind === "unlinked",
        ...(state.kind === "unlinked" ? { linked: false } : {}),
        running: false,
        stateReason: state.reason,
        lastError: state.failure,
      };
    case "running":
    case "stopped":
      return {
        configured: true,
        ...(state.linked ? { linked: true } : {}),
        running: state.kind === "running",
        ...(typeof state.connected === "boolean" ? { connected: state.connected } : {}),
        lastError: state.failure,
      };
  }
  return assertNeverState(state);
}

const CHANNEL_ACCOUNT_STATE_FIELDS = [
  "configured",
  "linked",
  "running",
  "connected",
  "stateReason",
  "lastError",
] as const;

export function applyChannelAccountState(
  snapshot: ChannelAccountSnapshot,
  state: ChannelAccountState,
): void {
  for (const field of CHANNEL_ACCOUNT_STATE_FIELDS) {
    delete snapshot[field];
  }
  Object.assign(snapshot, projectChannelAccountState(state));
}

export function projectChannelAccountDisplayState(
  state: ChannelAccountState,
  fallback?: ChannelAccountDisplayState,
): ChannelAccountDisplayState {
  switch (state.kind) {
    case "disabled":
      return "disabled";
    case "unconfigured":
      return "not configured";
    case "unlinked":
      return "not linked";
    case "running":
    case "stopped":
      return state.linked ? "linked" : (fallback ?? "configured");
  }
  return assertNeverState(state);
}
