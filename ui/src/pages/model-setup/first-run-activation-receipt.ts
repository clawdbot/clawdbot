import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { ApplicationContext } from "../../app/context.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { activationTimeoutForKind } from "./state.ts";

const FIRST_RUN_ACTIVATION_RECEIPT_KEY = "openclaw.modelSetup.pendingActivation.v1";
const DEVICE_IDENTITY_KEY = "openclaw-device-identity-v1";
const ACTIVATION_DEADLINE_SAFETY_MS = 5_000;

type ActivationContext = Pick<ApplicationContext, "gateway" | "agentSelection">;

export type FirstRunActivationReceipt = {
  version: 1;
  gatewayUrl: string;
  agentId: string;
  modelRef: string;
  kind: string;
  deadlineMs: number;
  owner: string;
};

function activationOwner(
  context: ActivationContext,
  receipt: Omit<FirstRunActivationReceipt, "owner">,
  storage: Storage,
): string | null {
  try {
    const identity: {
      version?: unknown;
      privateKey?: unknown;
    } | null = JSON.parse(storage.getItem(DEVICE_IDENTITY_KEY) ?? "null");
    if (
      identity?.version !== 1 ||
      typeof identity.privateKey !== "string" ||
      !identity.privateKey
    ) {
      return null;
    }
    const connection = context.gateway.connection;
    const explicitAuth = connection.token || connection.password || connection.bootstrapToken;
    const deviceToken = explicitAuth ? "" : context.gateway.snapshot.hello?.auth?.deviceToken;
    if (!explicitAuth && !deviceToken) {
      return null;
    }
    // The existing high-entropy device key keeps this auth-bound receipt from
    // becoming a standalone, offline verifier for a Gateway token or password.
    const values = [
      receipt.gatewayUrl,
      receipt.agentId,
      receipt.modelRef,
      receipt.kind,
      String(receipt.deadlineMs),
      connection.token,
      connection.password,
      connection.bootstrapToken,
      connection.bootstrapProfile ?? "",
      deviceToken ?? "",
    ];
    const encoder = new TextEncoder();
    const framed = values.map((value) => `${encoder.encode(value).length}:${value}`).join("|");
    return Array.from(hmac(sha256, encoder.encode(identity.privateKey), encoder.encode(framed)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

function clearReceipt(storage: Storage): void {
  try {
    storage.removeItem(FIRST_RUN_ACTIVATION_RECEIPT_KEY);
  } catch {
    // Disabled or quota-blocked browser storage must never block onboarding.
  }
}

export function readFirstRunActivationReceipt(
  context: ActivationContext,
): FirstRunActivationReceipt | null {
  const storage = getSafeLocalStorage();
  if (!storage || context.gateway.snapshot.phase !== "connected") {
    return null;
  }
  try {
    const raw = storage.getItem(FIRST_RUN_ACTIVATION_RECEIPT_KEY);
    if (!raw) {
      return null;
    }
    const receipt: FirstRunActivationReceipt = JSON.parse(raw);
    if (
      receipt?.version !== 1 ||
      typeof receipt.gatewayUrl !== "string" ||
      typeof receipt.agentId !== "string" ||
      typeof receipt.modelRef !== "string" ||
      typeof receipt.kind !== "string" ||
      typeof receipt.deadlineMs !== "number" ||
      !Number.isFinite(receipt.deadlineMs) ||
      receipt.deadlineMs <= Date.now() ||
      typeof receipt.owner !== "string" ||
      receipt.gatewayUrl !== gatewayCredentialScope(context.gateway.connection.gatewayUrl) ||
      receipt.agentId !== (context.agentSelection.state.selectedId ?? "")
    ) {
      clearReceipt(storage);
      return null;
    }
    const { owner, ...identity } = receipt;
    if (activationOwner(context, identity, storage) !== owner) {
      clearReceipt(storage);
      return null;
    }
    return receipt;
  } catch {
    clearReceipt(storage);
    return null;
  }
}

export function persistFirstRunActivationReceipt(
  context: ActivationContext,
  candidate: { kind: string; modelRef: string },
): FirstRunActivationReceipt | null {
  const storage = getSafeLocalStorage();
  if (!storage || context.gateway.snapshot.phase !== "connected") {
    return null;
  }
  try {
    const receipt = {
      version: 1 as const,
      gatewayUrl: gatewayCredentialScope(context.gateway.connection.gatewayUrl),
      agentId: context.agentSelection.state.selectedId ?? "",
      modelRef: candidate.modelRef,
      kind: candidate.kind,
      deadlineMs:
        Date.now() + activationTimeoutForKind(candidate.kind) + ACTIVATION_DEADLINE_SAFETY_MS,
    };
    const owner = activationOwner(context, receipt, storage);
    if (!owner) {
      return null;
    }
    const owned = { ...receipt, owner };
    storage.setItem(FIRST_RUN_ACTIVATION_RECEIPT_KEY, JSON.stringify(owned));
    return owned;
  } catch {
    return null;
  }
}

export function clearFirstRunActivationReceipt(): void {
  const storage = getSafeLocalStorage();
  if (storage) {
    clearReceipt(storage);
  }
}

export function resumeFirstRunActivation(
  navigation: {
    context: ActivationContext;
    isStillDefaultLanding: () => boolean;
    redirect: () => void;
  },
  ownerSnapshot: ActivationContext["gateway"]["snapshot"],
  ownerRevision: number,
  ownerAgentId: string | null,
  isSettled: () => boolean,
  settle: () => void,
): void {
  const { context } = navigation;
  const snapshot = context.gateway.snapshot;
  if (
    !isSettled() &&
    snapshot.phase === "connected" &&
    snapshot.client === ownerSnapshot.client &&
    snapshot.hello === ownerSnapshot.hello &&
    context.gateway.connectionRevision === ownerRevision &&
    (context.agentSelection.state.selectedId?.trim() || null) === ownerAgentId &&
    navigation.isStillDefaultLanding() &&
    readFirstRunActivationReceipt(context) !== null
  ) {
    navigation.redirect();
  }
  settle();
}
