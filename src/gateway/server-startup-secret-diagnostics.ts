/** Aggregates redacted SecretRef degradation diagnostics at the Gateway activation boundary. */
import { isProviderScopedSecretResolutionError } from "../secrets/resolve-errors.js";
import {
  redactSecretDegradationReason,
  SECRET_DEGRADATION_RETRY_HINT,
  type DegradedSecretOwner,
  type SecretDegradation,
} from "../secrets/runtime-degraded-state.js";
import type { GatewayStartupLog } from "./server-startup-config-helpers.js";

function logSecretDegradation(log: GatewayStartupLog, degradation: SecretDegradation): void {
  const reason = redactSecretDegradationReason(degradation.reason);
  log.warn(
    `[SECRETS_DEGRADED] ${degradation.state} ${degradation.kind}:${degradation.id}: ` +
      `${reason}. Retry: ${degradation.retryHint}.`,
    {
      event: "secrets.degraded",
      ownerKind: degradation.kind,
      ownerId: degradation.id,
      reason,
      state: degradation.state,
      retryHint: degradation.retryHint,
    },
  );
}

function logSecretProviderDegradation(
  log: GatewayStartupLog,
  providerFailure: NonNullable<DegradedSecretOwner["providerFailures"]>[number],
  degradations: SecretDegradation[],
): void {
  const reason = redactSecretDegradationReason(
    degradations[0]?.reason ?? "secret resolution failed",
  );
  const affectedOwners = degradations
    .map(({ kind, id, state }) => ({ ownerKind: kind, ownerId: id, state }))
    .toSorted(
      (left, right) =>
        left.ownerKind.localeCompare(right.ownerKind) || left.ownerId.localeCompare(right.ownerId),
    );
  const affectedOwnerSummary = affectedOwners
    .map((owner) => `${owner.state} ${owner.ownerKind}:${owner.ownerId}`)
    .join(", ");
  log.warn(
    `[SECRETS_PROVIDER_DEGRADED] ${providerFailure.source}:${providerFailure.provider}: ${reason}. ` +
      `Affected owners: ${affectedOwnerSummary}. Retry: ${SECRET_DEGRADATION_RETRY_HINT}.`,
    {
      event: "secrets.provider_degraded",
      source: providerFailure.source,
      provider: providerFailure.provider,
      reason,
      affectedOwners,
      retryHint: SECRET_DEGRADATION_RETRY_HINT,
    },
  );
}

/** Logs one provider diagnostic per failed provider and owner diagnostics for ref failures. */
export function logPreparedSecretDegradations(
  log: GatewayStartupLog,
  owners: DegradedSecretOwner[],
): void {
  const providerDegradations = new Map<
    string,
    {
      providerFailure: NonNullable<DegradedSecretOwner["providerFailures"]>[number];
      degradations: SecretDegradation[];
    }
  >();
  for (const owner of owners) {
    const degradation: SecretDegradation = {
      kind: owner.ownerKind,
      id: owner.ownerId,
      reason: owner.reason,
      state: owner.degradationState ?? "cold",
      retryHint: SECRET_DEGRADATION_RETRY_HINT,
    };
    if (!owner.providerFailures?.length) {
      logSecretDegradation(log, degradation);
      continue;
    }
    if (owner.refFailureReason) {
      logSecretDegradation(log, { ...degradation, reason: owner.refFailureReason });
    }
    for (const providerFailure of owner.providerFailures) {
      const key = `${providerFailure.source}\0${providerFailure.provider}`;
      const group = providerDegradations.get(key);
      if (group) {
        group.degradations.push({ ...degradation, reason: "secret provider failed" });
      } else {
        providerDegradations.set(key, {
          providerFailure,
          degradations: [{ ...degradation, reason: "secret provider failed" }],
        });
      }
    }
  }
  for (const group of providerDegradations.values()) {
    logSecretProviderDegradation(log, group.providerFailure, group.degradations);
  }
}

/** Logs typed thrown failures with the same provider-level aggregation as prepared snapshots. */
export function logThrownSecretDegradations(
  log: GatewayStartupLog,
  error: unknown,
  degradations: SecretDegradation[],
): void {
  if (isProviderScopedSecretResolutionError(error)) {
    logSecretProviderDegradation(
      log,
      { source: error.source, provider: error.provider },
      degradations,
    );
    return;
  }
  for (const degradation of degradations) {
    logSecretDegradation(log, degradation);
  }
}
