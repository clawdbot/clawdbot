/** Process-local registry for SecretRef owners isolated during cold startup. */
import type { SecretRefSource } from "../config/types.secrets.js";
import {
  describeSecretResolutionError,
  isSecretResolutionError,
  type SecretResolutionFailureReason,
} from "./resolve-errors.js";

export type SecretDegradationReason =
  | SecretResolutionFailureReason
  | "resolved secret value was invalid"
  | "secret reference is not allowed for this provider"
  | "secret reference was not materialized by the active runtime"
  | "secret resolution failed";

export type SecretOwnerKind =
  | "account"
  | "capability"
  | "gateway"
  | "provider"
  | "route"
  | "unknown";

export type SecretAssignmentDisposition = "fail-closed" | "isolate";

export type DegradedSecretOwner = {
  ownerKind: Exclude<SecretOwnerKind, "unknown">;
  ownerId: string;
  state: "unavailable";
  /** Operator-facing reload state. Omitted legacy/runtime-discovered owners are cold. */
  degradationState?: "cold" | "stale";
  paths: string[];
  refKeys: string[];
  reason: string;
  /** Shared provider failure that made this owner unavailable. Runtime-internal diagnostic data. */
  providerFailures?: Array<{
    source: SecretRefSource;
    provider: string;
  }>;
  /** Ref-scoped failure retained when this owner also has a provider-scoped outage. */
  refFailureReason?: string;
};

/** SecretRef identities resolved for one owner in an active runtime snapshot. */
export type SecretOwnerRefState = Pick<DegradedSecretOwner, "ownerKind" | "ownerId" | "refKeys"> & {
  /** Identity of the full owner config that may use these values. */
  contractDigest?: string;
  /** Last materialized values, kept process-local for unchanged-ref reload fallback. */
  resolvedValues?: Array<{ refKey: string; value: unknown }>;
};

/** One owner from an atomic resolution attempt, including whether it caused the failure. */
type SecretResolutionErrorOwner = DegradedSecretOwner & {
  degradationState: "cold" | "stale";
  failureMatched: boolean;
  source: "auth-store" | "config";
};

export const SECRET_DEGRADATION_RETRY_HINT = "openclaw secrets reload" as const;

/** Only transient/unavailable resolution failures may enter degraded runtime state. */
export function isRetryableSecretDegradationReason(reason: string): boolean {
  return reason === "secret provider failed" || reason === "secret reference was not found";
}

/** Redacted owner details for one structured degradation warning. */
export type SecretDegradation = {
  kind: SecretOwnerKind;
  id: string;
  reason: string;
  state: "cold" | "stale";
  retryHint: typeof SECRET_DEGRADATION_RETRY_HINT;
};

/** Maps a typed resolution failure to redacted owner warnings when attribution is safe. */
export function classifySecretResolutionErrorDegradations(error: unknown): SecretDegradation[] {
  const degradations = listSecretResolutionErrorOwners(error).flatMap((owner) =>
    owner.failureMatched
      ? [
          {
            kind: owner.ownerKind,
            id: owner.ownerId,
            reason: owner.reason,
            state: owner.degradationState,
            retryHint: SECRET_DEGRADATION_RETRY_HINT,
          },
        ]
      : [],
  );
  if (degradations.length > 0 || !isSecretResolutionError(error)) {
    return degradations;
  }
  const reason = describeSecretResolutionError(error);
  return reason
    ? [
        {
          kind: "unknown",
          id: "unmapped",
          reason,
          state: "cold",
          retryHint: SECRET_DEGRADATION_RETRY_HINT,
        },
      ]
    : [];
}

/** Preserves known failure classes while dropping any embedded SecretRef identity. */
export function redactSecretDegradationReason(reason: string): SecretDegradationReason {
  switch (reason) {
    case "secret provider failed":
    case "secret provider policy denied resolution":
    case "secret provider response violated its contract":
    case "secret reference is not allowed for this provider":
    case "secret reference was not found":
    case "secret reference was not materialized by the active runtime":
    case "resolved secret value was invalid":
    case "secret resolution failed":
      return reason;
    default:
      return "secret resolution failed";
  }
}

const SECRET_SURFACE_UNAVAILABLE_ERROR_CODE = "SECRET_SURFACE_UNAVAILABLE";

/** Runtime error returned when a request targets an isolated SecretRef owner. */
export class SecretSurfaceUnavailableError extends Error {
  readonly code = SECRET_SURFACE_UNAVAILABLE_ERROR_CODE;
  readonly ownerKind: DegradedSecretOwner["ownerKind"];
  readonly ownerId: string;
  readonly paths: string[];

  constructor(owner: DegradedSecretOwner) {
    super(
      `Secret owner ${owner.ownerKind}:${owner.ownerId} is configured but unavailable (${owner.reason}).`,
    );
    this.name = "SecretSurfaceUnavailableError";
    this.ownerKind = owner.ownerKind;
    this.ownerId = owner.ownerId;
    this.paths = [...owner.paths];
  }
}

let activeDegradedOwners: DegradedSecretOwner[] = [];
const resolutionErrorOwners = new WeakMap<object, SecretResolutionErrorOwner[]>();
const activeCredentialDegradedOwners = new Map<string, DegradedSecretOwner>();

function ownerKey(ownerKind: DegradedSecretOwner["ownerKind"], ownerId: string): string {
  return `${ownerKind}\0${ownerId}`;
}

function cloneOwner(owner: DegradedSecretOwner): DegradedSecretOwner {
  return {
    ...owner,
    paths: [...owner.paths],
    refKeys: [...owner.refKeys],
  };
}

function cloneResolutionErrorOwner(owner: SecretResolutionErrorOwner): SecretResolutionErrorOwner {
  return {
    ...cloneOwner(owner),
    degradationState: owner.degradationState,
    failureMatched: owner.failureMatched,
    source: owner.source,
  };
}

/** Publishes the degraded-owner snapshot at the same edge as runtime config activation. */
export function setActiveDegradedSecretOwners(owners: readonly DegradedSecretOwner[]): void {
  activeDegradedOwners = owners.map(cloneOwner);
  activeCredentialDegradedOwners.clear();
}

/** Publishes or clears one runtime-discovered channel credential owner. */
export function setActiveCredentialDegradedOwner(owner: DegradedSecretOwner): void {
  activeCredentialDegradedOwners.set(ownerKey(owner.ownerKind, owner.ownerId), cloneOwner(owner));
}

/** Clears one runtime-discovered channel credential owner before re-inspection. */
export function clearActiveCredentialDegradedOwner(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): void {
  activeCredentialDegradedOwners.delete(ownerKey(ownerKind, ownerId));
}

/** Returns the active degraded-owner snapshot without exposing mutable registry state. */
export function listActiveDegradedSecretOwners(): DegradedSecretOwner[] {
  return [
    ...activeDegradedOwners.map(cloneOwner),
    ...Array.from(activeCredentialDegradedOwners.values(), cloneOwner),
  ];
}

/** Associates a strict activation failure with the owners it prevented from refreshing. */
export function associateSecretResolutionErrorOwners(
  error: unknown,
  owners: readonly SecretResolutionErrorOwner[],
): void {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return;
  }
  resolutionErrorOwners.set(error, owners.map(cloneResolutionErrorOwner));
}

/** Returns owner metadata recorded for a strict activation failure. */
export function listSecretResolutionErrorOwners(error: unknown): SecretResolutionErrorOwner[] {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return [];
  }
  return (resolutionErrorOwners.get(error) ?? []).map(cloneResolutionErrorOwner);
}

/** Returns one active degraded owner, if present. */
export function findActiveDegradedSecretOwner(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): DegradedSecretOwner | undefined {
  const owner =
    activeDegradedOwners.find(
      (entry) =>
        entry.ownerKind === ownerKind &&
        entry.ownerId === ownerId &&
        entry.degradationState !== "stale",
    ) ?? activeCredentialDegradedOwners.get(ownerKey(ownerKind, ownerId));
  return owner ? cloneOwner(owner) : undefined;
}

/** Throws the canonical typed error when an owner was isolated at startup. */
export function assertSecretOwnerAvailable(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): void {
  const owner = findActiveDegradedSecretOwner(ownerKind, ownerId);
  if (owner) {
    throw new SecretSurfaceUnavailableError(owner);
  }
}
