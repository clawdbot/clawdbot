import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const REEF_REGISTRATION_NAMESPACE = "registration";
export const REEF_REGISTRATION_IDENTITY_KEY = "identity";
export const REEF_REGISTRATION_SESSION_KEY = "setup-session";
export const REEF_REGISTRATION_MAX_ENTRIES = 2;

export type ReefIdentityBinding = { handle: string; relayUrl: string };
type ReefIdentityPendingRecord = ReefIdentityBinding & {
  kind: "pending";
  owner: string;
  expiresAt: number;
};
type ReefIdentityReservation = {
  binding: ReefIdentityBinding;
  owner?: string;
};
export type ReefSetupSession = { session: string; relayUrl: string; email: string };

const REEF_IDENTITY_RESERVATION_MS = 10 * 60_000;

function openRegistrationStore(
  runtime: PluginRuntime,
): PluginStateSyncKeyedStore<ReefIdentityBinding | ReefIdentityPendingRecord | ReefSetupSession> {
  return runtime.state.openSyncKeyedStore<
    ReefIdentityBinding | ReefIdentityPendingRecord | ReefSetupSession
  >({
    namespace: REEF_REGISTRATION_NAMESPACE,
    maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export function parseReefIdentityBinding(value: unknown): ReefIdentityBinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefIdentityBinding & { kind?: unknown }>;
  if (parsed.kind === "pending") {
    return undefined;
  }
  return typeof parsed.handle === "string" &&
    parsed.handle.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0
    ? { handle: parsed.handle, relayUrl: parsed.relayUrl }
    : undefined;
}

function parseReefIdentityPendingRecord(value: unknown): ReefIdentityPendingRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefIdentityPendingRecord>;
  return parsed.kind === "pending" &&
    typeof parsed.handle === "string" &&
    parsed.handle.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0 &&
    typeof parsed.owner === "string" &&
    parsed.owner.length > 0 &&
    Number.isSafeInteger(parsed.expiresAt) &&
    (parsed.expiresAt ?? 0) > 0
    ? {
        kind: "pending",
        handle: parsed.handle,
        relayUrl: parsed.relayUrl,
        owner: parsed.owner,
        expiresAt: parsed.expiresAt!,
      }
    : undefined;
}

function reefIdentityConflict(binding: ReefIdentityBinding): Error {
  return new Error(
    `This OpenClaw state already holds the Reef identity @${binding.handle} on ${binding.relayUrl}. Re-register the same handle and relay.`,
  );
}

export function parseReefSetupSession(value: unknown): ReefSetupSession | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefSetupSession>;
  return typeof parsed.session === "string" &&
    parsed.session.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0 &&
    typeof parsed.email === "string" &&
    parsed.email.length > 0
    ? { session: parsed.session, relayUrl: parsed.relayUrl, email: parsed.email }
    : undefined;
}

export function loadReefIdentityBinding(runtime: PluginRuntime): ReefIdentityBinding | undefined {
  return parseReefIdentityBinding(
    openRegistrationStore(runtime).lookup(REEF_REGISTRATION_IDENTITY_KEY),
  );
}

export function assertReefIdentityBinding(
  runtime: PluginRuntime,
  binding: ReefIdentityBinding,
): void {
  const existing = loadReefIdentityBinding(runtime);
  if (!existing) {
    throw new Error(
      "Reef identity binding is missing; run openclaw doctor --fix or register this claw",
    );
  }
  if (existing.handle !== binding.handle || existing.relayUrl !== binding.relayUrl) {
    throw reefIdentityConflict(existing);
  }
}

export function reserveReefIdentityBinding(
  runtime: PluginRuntime,
  binding: ReefIdentityBinding,
): ReefIdentityReservation {
  const parsed = parseReefIdentityBinding(binding);
  if (!parsed) {
    throw new Error("invalid Reef identity binding");
  }
  const store = openRegistrationStore(runtime);
  const update = store.update;
  if (!update) {
    throw new Error("Reef identity reservation requires atomic plugin-state updates");
  }
  let reservation: ReefIdentityReservation | undefined;
  let conflict: ReefIdentityBinding | undefined;
  update(REEF_REGISTRATION_IDENTITY_KEY, (current) => {
    const existing = parseReefIdentityBinding(current);
    if (existing) {
      if (existing.handle !== parsed.handle || existing.relayUrl !== parsed.relayUrl) {
        conflict = existing;
      } else {
        reservation = { binding: parsed };
      }
      return existing;
    }
    const pending = parseReefIdentityPendingRecord(current);
    if (pending) {
      const sameBinding = pending.handle === parsed.handle && pending.relayUrl === parsed.relayUrl;
      // Never transfer a live reservation. After expiry, only the same target
      // may retry because the original relay request may already have committed.
      if (pending.expiresAt > Date.now() || !sameBinding) {
        conflict = pending;
        return pending;
      }
    }
    const owner = randomUUID();
    reservation = { binding: parsed, owner };
    return {
      kind: "pending",
      ...parsed,
      owner,
      expiresAt: Date.now() + REEF_IDENTITY_RESERVATION_MS,
    };
  });
  if (conflict) {
    throw reefIdentityConflict(conflict);
  }
  return reservation!;
}

export function finalizeReefIdentityBinding(
  runtime: PluginRuntime,
  reservation: ReefIdentityReservation,
): void {
  if (!reservation.owner) {
    return;
  }
  const store = openRegistrationStore(runtime);
  const update = store.update;
  if (!update) {
    throw new Error("Reef identity reservation requires atomic plugin-state updates");
  }
  let finalized = false;
  update(REEF_REGISTRATION_IDENTITY_KEY, (current) => {
    const existing = parseReefIdentityBinding(current);
    if (
      existing?.handle === reservation.binding.handle &&
      existing.relayUrl === reservation.binding.relayUrl
    ) {
      finalized = true;
      return existing;
    }
    const pending = parseReefIdentityPendingRecord(current);
    if (pending?.owner !== reservation.owner) {
      return current;
    }
    finalized = true;
    return reservation.binding;
  });
  if (!finalized) {
    throw new Error("Reef identity reservation was replaced before registration completed");
  }
}

export function releaseReefIdentityReservation(
  runtime: PluginRuntime,
  reservation: ReefIdentityReservation,
): void {
  if (!reservation.owner) {
    return;
  }
  const deleteIf = openRegistrationStore(runtime).deleteIf;
  if (!deleteIf) {
    throw new Error("Reef identity reservation requires atomic plugin-state updates");
  }
  deleteIf(
    REEF_REGISTRATION_IDENTITY_KEY,
    (current) => parseReefIdentityPendingRecord(current)?.owner === reservation.owner,
  );
}

export function loadReefSetupSession(runtime: PluginRuntime): ReefSetupSession | undefined {
  return parseReefSetupSession(
    openRegistrationStore(runtime).lookup(REEF_REGISTRATION_SESSION_KEY),
  );
}

export function saveReefSetupSession(runtime: PluginRuntime, session: ReefSetupSession): void {
  const parsed = parseReefSetupSession(session);
  if (!parsed) {
    throw new Error("invalid Reef setup session");
  }
  openRegistrationStore(runtime).register(REEF_REGISTRATION_SESSION_KEY, parsed);
}

export function clearReefSetupSession(runtime: PluginRuntime): void {
  openRegistrationStore(runtime).delete(REEF_REGISTRATION_SESSION_KEY);
}
