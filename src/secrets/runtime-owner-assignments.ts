/** Resolves SecretRef assignments atomically by owning runtime surface. */
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { toErrorObject } from "../infra/errors.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { secretRefKey } from "./ref-contract.js";
import {
  describeSecretResolutionError,
  isProviderScopedSecretResolutionError,
  isSecretResolutionError,
} from "./resolve-errors.js";
import { resolveSecretRefValues, resolveSecretRefValuesSettledByProvider } from "./resolve.js";
import { getSecretAssignmentSource } from "./runtime-assignment-provenance.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import type {
  DegradedSecretOwner,
  SecretDegradationReason,
  SecretOwnerRefState,
} from "./runtime-degraded-state.js";
import {
  associateSecretResolutionErrorOwners,
  isRetryableSecretDegradationReason,
} from "./runtime-degraded-state.js";
import { combineSecretOwnerContractDigests } from "./runtime-owner-contract.js";
import {
  applyResolvedAssignments,
  getSecretAssignmentValidationFailures,
  pushWarning,
  type ResolverContext,
  type SecretAssignment,
} from "./runtime-shared.js";
import {
  getActiveSecretsRuntimeSnapshot,
  hasSameSecretProviderDefinition,
} from "./runtime-state.js";

type SecretResolutionOptions = Parameters<typeof resolveSecretRefValues>[1];

/** Classifies whether an unresolved owner has an unchanged active SecretRef snapshot. */
export function classifySecretOwnerDegradationState(params: {
  ownerKind: DegradedSecretOwner["ownerKind"];
  ownerId: string;
  refs: SecretRef[];
  config: OpenClawConfig;
  contractDigest?: string;
}): "cold" | "stale" {
  const active = getActiveSecretsRuntimeSnapshot();
  if (
    !active ||
    active.degradedOwners?.some(
      (entry) =>
        entry.ownerKind === params.ownerKind &&
        entry.ownerId === params.ownerId &&
        entry.degradationState !== "stale",
    )
  ) {
    return "cold";
  }
  const activeOwner = active.secretOwners?.find(
    (entry) => entry.ownerKind === params.ownerKind && entry.ownerId === params.ownerId,
  );
  const refKeys = params.refs.map(secretRefKey).toSorted();
  const providerDefinitionsMatch = params.refs.every((ref) =>
    hasSameSecretProviderDefinition(ref, [active.sourceConfig, params.config]),
  );
  return activeOwner &&
    Boolean(params.contractDigest) &&
    activeOwner.contractDigest === params.contractDigest &&
    isDeepStrictEqual(activeOwner.refKeys.toSorted(), refKeys) &&
    providerDefinitionsMatch
    ? "stale"
    : "cold";
}

function registerResolvedValuesForRedaction(resolved: ReadonlyMap<string, unknown>): void {
  for (const value of resolved.values()) {
    if (typeof value === "string") {
      registerSecretValueForRedaction(value);
    }
  }
}

function assignmentOwnerKey(assignment: SecretAssignment): string {
  return `${getSecretAssignmentSource(assignment)}\0${assignment.ownerKind}\0${assignment.ownerId}`;
}

function groupAssignmentsByOwner(assignments: SecretAssignment[]): SecretAssignment[][] {
  const groups = new Map<string, SecretAssignment[]>();
  for (const assignment of assignments) {
    const key = assignmentOwnerKey(assignment);
    const group = groups.get(key);
    if (group) {
      const owner = group[0]!;
      if (
        owner.requiredForGateway !== assignment.requiredForGateway ||
        owner.disposition !== assignment.disposition
      ) {
        throw new Error(
          `Secret owner ${assignment.ownerKind}:${assignment.ownerId} has conflicting assignment policy.`,
        );
      }
      group.push(assignment);
      continue;
    }
    groups.set(key, [assignment]);
  }
  return [...groups.values()];
}

/** Captures every typed owner/ref relationship for later reload classification. */
export function listSecretAssignmentOwners(
  assignments: SecretAssignment[],
  resolvedValues: ReadonlyMap<string, unknown>,
): SecretOwnerRefState[] {
  return groupAssignmentsByOwner(assignments).flatMap((ownerAssignments) => {
    const owner = ownerAssignments[0];
    return !owner || owner.ownerKind === "unknown"
      ? []
      : [
          {
            ownerKind: owner.ownerKind,
            ownerId: owner.ownerId,
            refKeys: ownerAssignments.map((assignment) => secretRefKey(assignment.ref)).toSorted(),
            contractDigest: combineSecretOwnerContractDigests(
              ownerAssignments.flatMap((assignment) =>
                assignment.ownerContractDigest ? [assignment.ownerContractDigest] : [],
              ),
            ),
            resolvedValues: ownerAssignments.flatMap((assignment) => {
              const refKey = secretRefKey(assignment.ref);
              return resolvedValues.has(refKey)
                ? [{ refKey, value: structuredClone(resolvedValues.get(refKey)) }]
                : [];
            }),
          },
        ];
  });
}

function createDegradedOwner(
  assignments: SecretAssignment[],
  reason: SecretDegradationReason,
  degradationState: "cold" | "stale" = "cold",
  providerFailures?: DegradedSecretOwner["providerFailures"],
  refFailureReason?: string,
): DegradedSecretOwner {
  const owner = assignments[0]!;
  if (owner.ownerKind === "unknown") {
    throw new Error(`Secret assignment ${owner.path} has no runtime owner.`);
  }
  return {
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: "unavailable",
    degradationState,
    paths: assignments.map((assignment) => assignment.path),
    refKeys: assignments.map((assignment) => secretRefKey(assignment.ref)),
    reason,
    ...(providerFailures?.length ? { providerFailures } : {}),
    ...(refFailureReason ? { refFailureReason } : {}),
  };
}

function associateAssignmentFailureOwners(params: {
  assignments: SecretAssignment[];
  error: unknown;
  config: OpenClawConfig;
}): void {
  const validationFailures = getSecretAssignmentValidationFailures(params.error);
  const validationFailureRefKeys = new Set(validationFailures.map((failure) => failure.refKey));
  const validationFailureOwnerKeys = new Set(
    validationFailures.flatMap((failure) =>
      params.assignments
        .filter(
          (assignment) =>
            assignment.ownerKind === failure.ownerKind &&
            assignment.ownerId === failure.ownerId &&
            assignment.expected === failure.expected &&
            secretRefKey(assignment.ref) === failure.refKey,
        )
        .map(assignmentOwnerKey),
    ),
  );
  const reason =
    validationFailures.length > 0
      ? "resolved secret value was invalid"
      : describeSecretResolutionError(params.error);
  if (!reason) {
    return;
  }
  const owners = groupAssignmentsByOwner(params.assignments).flatMap((assignments) => {
    if (assignments[0]?.ownerKind === "unknown") {
      return [];
    }
    const failureMatched = assignments.some((assignment) =>
      validationFailures.length > 0
        ? validationFailureOwnerKeys.has(assignmentOwnerKey(assignment))
        : assignmentMatchesResolutionFailure(assignment, params.error),
    );
    if (!failureMatched) {
      return [];
    }
    const degradedOwner = createDegradedOwner(assignments, reason);
    return [
      {
        ...degradedOwner,
        degradationState: classifySecretOwnerDegradationState({
          ownerKind: degradedOwner.ownerKind,
          ownerId: degradedOwner.ownerId,
          refs: assignments.map((assignment) => assignment.ref),
          config: params.config,
          contractDigest: combineSecretOwnerContractDigests(
            assignments.flatMap((assignment) =>
              assignment.ownerContractDigest ? [assignment.ownerContractDigest] : [],
            ),
          ),
        }),
        failureMatched,
        source: getSecretAssignmentSource(assignments[0]!),
      },
    ];
  });
  const failureRefs = new Map(
    validationFailures.length > 0
      ? params.assignments
          .filter((assignment) => validationFailureRefKeys.has(secretRefKey(assignment.ref)))
          .map((assignment) => [secretRefKey(assignment.ref), assignment.ref] as const)
      : params.assignments
          .filter((assignment) => assignmentMatchesResolutionFailure(assignment, params.error))
          .map((assignment) => [secretRefKey(assignment.ref), assignment.ref] as const),
  );
  const providerFailure =
    validationFailures.length === 0 && isProviderScopedSecretResolutionError(params.error)
      ? params.error
      : null;
  const providerRefPrefix = providerFailure
    ? `${providerFailure.source}:${providerFailure.provider}:`
    : null;
  const ownerKeys = new Set(
    owners.map((owner) => `${owner.source}\0${owner.ownerKind}\0${owner.ownerId}`),
  );
  const collectedOwnerKeys = new Set(params.assignments.map(assignmentOwnerKey));
  const activeSnapshot = getActiveSecretsRuntimeSnapshot();
  const activeAuthOwnerIds = new Set(
    (activeSnapshot?.authStores ?? []).flatMap(({ agentDir, store }) =>
      Object.keys(store.profiles).map((profileId) =>
        resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
      ),
    ),
  );
  const activeCoOwners = (activeSnapshot?.secretOwners ?? []).flatMap((owner) => {
    const source =
      owner.ownerKind === "account" && activeAuthOwnerIds.has(owner.ownerId)
        ? ("auth-store" as const)
        : ("config" as const);
    const ownerKey = `${source}\0${owner.ownerKind}\0${owner.ownerId}`;
    // Current assignments are authoritative. Retain active co-owners only for runtime surfaces
    // that strict assignment validation prevented this preparation from reaching.
    if (ownerKeys.has(ownerKey) || collectedOwnerKeys.has(ownerKey)) {
      return [];
    }
    const refs = owner.refKeys.flatMap((refKey) => {
      const ref = failureRefs.get(refKey);
      if (ref) {
        return [ref];
      }
      if (!providerFailure || !providerRefPrefix || !refKey.startsWith(providerRefPrefix)) {
        return [];
      }
      return [
        {
          source: providerFailure.source,
          provider: providerFailure.provider,
          id: refKey.slice(providerRefPrefix.length),
        },
      ];
    });
    if (refs.length === 0) {
      return [];
    }
    return [
      {
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        state: "unavailable" as const,
        paths: [],
        refKeys: [...owner.refKeys],
        reason,
        degradationState: classifySecretOwnerDegradationState({
          ownerKind: owner.ownerKind,
          ownerId: owner.ownerId,
          refs,
          config: params.config,
          contractDigest: owner.contractDigest,
        }),
        failureMatched: true,
        source,
      },
    ];
  });
  associateSecretResolutionErrorOwners(params.error, [...owners, ...activeCoOwners]);
}

/** Emits the canonical warning for one isolated runtime secret owner. */
export function warnDegradedSecretOwner(
  context: ResolverContext,
  owner: DegradedSecretOwner,
): void {
  pushWarning(context, {
    code: "SECRETS_OWNER_UNAVAILABLE",
    path: owner.paths[0]!,
    message: `Secret owner ${owner.ownerKind}:${owner.ownerId} is ${
      owner.degradationState === "stale" ? "using last-known-good" : "configured-unavailable"
    }; paths: ${owner.paths.join(", ")}; reason: ${owner.reason}.`,
  });
}

async function resolveStrictAssignments(params: {
  assignments: SecretAssignment[];
  options: SecretResolutionOptions;
}): Promise<Map<string, unknown>> {
  try {
    const resolved = await resolveSecretRefValues(
      params.assignments.map((assignment) => assignment.ref),
      params.options,
    );
    registerResolvedValuesForRedaction(resolved);
    applyResolvedAssignments({ assignments: params.assignments, resolved });
    return resolved;
  } catch (error) {
    associateAssignmentFailureOwners({
      assignments: params.assignments,
      error,
      config: params.options.config,
    });
    throw error;
  }
}

function assignmentMatchesResolutionFailure(assignment: SecretAssignment, error: unknown): boolean {
  if (!isSecretResolutionError(error)) {
    return false;
  }
  // Provider failures affect every ref under that exact source/provider pair. Ref failures
  // additionally require the id, so equal ids under sibling providers never share attribution.
  if (assignment.ref.source !== error.source || assignment.ref.provider !== error.provider) {
    return false;
  }
  return isProviderScopedSecretResolutionError(error) || assignment.ref.id.trim() === error.refId;
}

function assertOwnerCanBeIsolated(
  assignments: SecretAssignment[],
  error: unknown,
): SecretDegradationReason {
  const owner = assignments[0]!;
  const reason = describeSecretResolutionError(error);
  if (
    !reason ||
    !isRetryableSecretDegradationReason(reason) ||
    owner.ownerKind === "unknown" ||
    owner.requiredForGateway ||
    owner.disposition === "fail-closed"
  ) {
    throw error;
  }
  return reason;
}

export async function resolveAndApplySecretAssignments(params: {
  assignments: SecretAssignment[];
  context: ResolverContext;
  options: SecretResolutionOptions;
  allowOwnerIsolation?: boolean;
}): Promise<{ degradedOwners: DegradedSecretOwner[]; resolvedValues: Map<string, unknown> }> {
  if (!params.allowOwnerIsolation) {
    return {
      degradedOwners: [],
      resolvedValues: await resolveStrictAssignments(params),
    };
  }

  const degradedOwners: DegradedSecretOwner[] = [];
  const resolvedValues = new Map<string, unknown>();
  let pendingOwners = groupAssignmentsByOwner(params.assignments);
  while (pendingOwners.length > 0) {
    const resolution = await resolveSecretRefValuesSettledByProvider(
      pendingOwners.flat().map((assignment) => assignment.ref),
      params.options,
    );
    registerResolvedValuesForRedaction(resolution.resolved);

    const failedOwners = new Map<
      SecretAssignment[],
      {
        reason: SecretDegradationReason;
        providerFailures: NonNullable<DegradedSecretOwner["providerFailures"]>;
        refFailureReason?: SecretDegradationReason;
      }
    >();
    for (const failure of resolution.failures) {
      associateAssignmentFailureOwners({
        assignments: pendingOwners.flat(),
        error: failure.error,
        config: params.options.config,
      });
      const matchingOwners = pendingOwners.filter((assignments) =>
        assignments.some((assignment) =>
          assignmentMatchesResolutionFailure(assignment, failure.error),
        ),
      );
      if (matchingOwners.length === 0) {
        throw failure.error;
      }
      for (const assignments of matchingOwners) {
        const reason = assertOwnerCanBeIsolated(assignments, failure.error);
        const existing = failedOwners.get(assignments);
        const providerFailure = isProviderScopedSecretResolutionError(failure.error)
          ? { source: failure.error.source, provider: failure.error.provider }
          : undefined;
        if (!existing) {
          failedOwners.set(assignments, {
            reason,
            providerFailures: providerFailure ? [providerFailure] : [],
            ...(!providerFailure ? { refFailureReason: reason } : {}),
          });
        } else if (
          providerFailure &&
          !existing.providerFailures.some(
            (entry) =>
              entry.source === providerFailure.source &&
              entry.provider === providerFailure.provider,
          )
        ) {
          existing.providerFailures.push(providerFailure);
        } else if (!providerFailure && !existing.refFailureReason) {
          existing.refFailureReason = reason;
        }
      }
    }

    const readyAssignments = pendingOwners
      .filter(
        (assignments) =>
          !failedOwners.has(assignments) &&
          assignments.every((assignment) => resolution.resolved.has(secretRefKey(assignment.ref))),
      )
      .flat();
    if (readyAssignments.length > 0) {
      // Validate the whole ready set so owners sharing one invalid ref are all reported.
      // Failure association filters by validated owner keys; unrelated owners stay healthy.
      try {
        applyResolvedAssignments({ assignments: readyAssignments, resolved: resolution.resolved });
        for (const assignment of readyAssignments) {
          const refKey = secretRefKey(assignment.ref);
          resolvedValues.set(refKey, structuredClone(resolution.resolved.get(refKey)));
        }
      } catch (error) {
        associateAssignmentFailureOwners({
          assignments: readyAssignments,
          error,
          config: params.options.config,
        });
        throw error;
      }
    }

    const nextPendingOwners: SecretAssignment[][] = [];
    for (const assignments of pendingOwners) {
      const failure = failedOwners.get(assignments);
      if (failure) {
        const owner = assignments[0]!;
        let degradationState = classifySecretOwnerDegradationState({
          ownerKind: owner.ownerKind as Exclude<typeof owner.ownerKind, "unknown">,
          ownerId: owner.ownerId,
          refs: assignments.map((assignment) => assignment.ref),
          config: params.options.config,
          contractDigest: combineSecretOwnerContractDigests(
            assignments.flatMap((assignment) =>
              assignment.ownerContractDigest ? [assignment.ownerContractDigest] : [],
            ),
          ),
        });
        const activeOwner =
          degradationState === "stale"
            ? getActiveSecretsRuntimeSnapshot()?.secretOwners?.find(
                (entry) => entry.ownerKind === owner.ownerKind && entry.ownerId === owner.ownerId,
              )
            : undefined;
        const activeValues = new Map(
          (activeOwner?.resolvedValues ?? []).map((entry) => [entry.refKey, entry.value]),
        );
        if (
          degradationState === "stale" &&
          assignments.some((assignment) => !activeValues.has(secretRefKey(assignment.ref)))
        ) {
          degradationState = "cold";
        }
        for (const assignment of assignments) {
          const refKey = secretRefKey(assignment.ref);
          if (degradationState === "stale") {
            const value = activeValues.get(refKey);
            assignment.apply(structuredClone(value));
            resolvedValues.set(refKey, structuredClone(value));
          } else if (assignment.applyUnavailable) {
            assignment.applyUnavailable();
          } else {
            // Canonicalize shorthand refs so runtime consumers can distinguish an unavailable ref
            // from a successfully resolved literal that happens to look like `${ENV_VAR}`.
            assignment.apply({ ...assignment.ref });
          }
        }
        const degradedOwner = createDegradedOwner(
          assignments,
          failure.refFailureReason ?? failure.reason,
          degradationState,
          failure.providerFailures,
          failure.refFailureReason,
        );
        degradedOwners.push(degradedOwner);
        warnDegradedSecretOwner(params.context, degradedOwner);
        continue;
      }
      if (
        assignments.every((assignment) => resolution.resolved.has(secretRefKey(assignment.ref)))
      ) {
        continue;
      }
      nextPendingOwners.push(assignments);
    }
    if (nextPendingOwners.length === pendingOwners.length) {
      throw toErrorObject(resolution.failures[0]?.error, "Secret resolution made no progress.");
    }
    pendingOwners = nextPendingOwners;
  }
  return { degradedOwners, resolvedValues };
}
