/** Logs prepared runtime warnings at the activation boundary that owns them. */
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

type OwnerUnavailableWarningMode = "include" | "exclude" | "active-only";

export function logRuntimeSecretWarnings(params: {
  snapshot: Pick<PreparedSecretsRuntimeSnapshot, "warnings" | "degradedOwners">;
  log: { warn: (message: string) => void };
  ownerUnavailable: OwnerUnavailableWarningMode;
}): void {
  const providerFailurePaths = new Set(
    (params.snapshot.degradedOwners ?? []).flatMap((owner) =>
      owner.providerFailures?.length && !owner.refFailureReason ? owner.paths : [],
    ),
  );
  const activeDegradedPaths =
    params.ownerUnavailable === "active-only"
      ? new Set((params.snapshot.degradedOwners ?? []).flatMap((owner) => owner.paths))
      : null;
  for (const warning of params.snapshot.warnings) {
    if (warning.code === "SECRETS_OWNER_UNAVAILABLE") {
      if (params.ownerUnavailable === "exclude") {
        continue;
      }
      if (activeDegradedPaths && !activeDegradedPaths.has(warning.path)) {
        continue;
      }
      // Provider-scoped outages are published once with their complete affected-owner list.
      if (providerFailurePaths.has(warning.path)) {
        continue;
      }
    } else if (params.ownerUnavailable === "active-only") {
      continue;
    }
    params.log.warn(`[${warning.code}] ${warning.message}`);
  }
}
