/** Resolves SecretRef assignments atomically by owning runtime surface. */
import { toErrorObject } from "../infra/errors.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { secretRefKey } from "./ref-contract.js";
import {
  describeSecretResolutionError,
  isProviderScopedSecretResolutionError,
  isSecretResolutionError,
} from "./resolve-errors.js";
import { resolveSecretRefValues, resolveSecretRefValuesSettledByProvider } from "./resolve.js";
import type { DegradedSecretOwner } from "./runtime-degraded-state.js";
import {
  applyResolvedAssignments,
  pushWarning,
  type ResolverContext,
  type SecretAssignment,
} from "./runtime-shared.js";

type SecretResolutionOptions = Parameters<typeof resolveSecretRefValues>[1];

function registerResolvedValuesForRedaction(resolved: ReadonlyMap<string, unknown>): void {
  for (const value of resolved.values()) {
    if (typeof value === "string") {
      registerSecretValueForRedaction(value);
    }
  }
}

function assignmentOwnerKey(assignment: SecretAssignment): string {
  return `${assignment.ownerKind}\0${assignment.ownerId}`;
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

function createDegradedOwner(assignments: SecretAssignment[], reason: string): DegradedSecretOwner {
  const owner = assignments[0]!;
  if (owner.ownerKind === "unknown") {
    throw new Error(`Secret assignment ${owner.path} has no runtime owner.`);
  }
  return {
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: "unavailable",
    paths: assignments.map((assignment) => assignment.path),
    refKeys: assignments.map((assignment) => secretRefKey(assignment.ref)),
    reason,
  };
}

/** Emits the canonical warning for one isolated runtime secret owner. */
export function warnDegradedSecretOwner(
  context: ResolverContext,
  owner: DegradedSecretOwner,
): void {
  pushWarning(context, {
    code: "SECRETS_OWNER_UNAVAILABLE",
    path: owner.paths[0]!,
    message:
      `Secret owner ${owner.ownerKind}:${owner.ownerId} is configured-unavailable; ` +
      `paths: ${owner.paths.join(", ")}; reason: ${owner.reason}.`,
  });
}

async function resolveStrictAssignments(params: {
  assignments: SecretAssignment[];
  options: SecretResolutionOptions;
}): Promise<void> {
  const resolved = await resolveSecretRefValues(
    params.assignments.map((assignment) => assignment.ref),
    params.options,
  );
  registerResolvedValuesForRedaction(resolved);
  applyResolvedAssignments({ assignments: params.assignments, resolved });
}

function assignmentMatchesResolutionFailure(assignment: SecretAssignment, error: unknown): boolean {
  if (!isSecretResolutionError(error)) {
    return false;
  }
  if (assignment.ref.source !== error.source || assignment.ref.provider !== error.provider) {
    return false;
  }
  return isProviderScopedSecretResolutionError(error) || assignment.ref.id.trim() === error.refId;
}

function assertOwnerCanBeIsolated(assignments: SecretAssignment[], error: unknown): string {
  const owner = assignments[0]!;
  const reason = describeSecretResolutionError(error);
  if (
    !reason ||
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
}): Promise<DegradedSecretOwner[]> {
  if (!params.allowOwnerIsolation) {
    await resolveStrictAssignments(params);
    return [];
  }

  const degradedOwners: DegradedSecretOwner[] = [];
  let pendingOwners = groupAssignmentsByOwner(params.assignments);
  while (pendingOwners.length > 0) {
    const resolution = await resolveSecretRefValuesSettledByProvider(
      pendingOwners.flat().map((assignment) => assignment.ref),
      params.options,
    );
    registerResolvedValuesForRedaction(resolution.resolved);

    const failedOwners = new Map<SecretAssignment[], string>();
    for (const failure of resolution.failures) {
      const matchingOwners = pendingOwners.filter((assignments) =>
        assignments.some((assignment) =>
          assignmentMatchesResolutionFailure(assignment, failure.error),
        ),
      );
      if (matchingOwners.length === 0) {
        throw failure.error;
      }
      for (const assignments of matchingOwners) {
        if (!failedOwners.has(assignments)) {
          failedOwners.set(assignments, assertOwnerCanBeIsolated(assignments, failure.error));
        }
      }
    }

    const nextPendingOwners: SecretAssignment[][] = [];
    for (const assignments of pendingOwners) {
      const failureReason = failedOwners.get(assignments);
      if (failureReason) {
        // Canonicalize shorthand refs so runtime consumers can distinguish an unavailable ref
        // from a successfully resolved literal that happens to look like `${ENV_VAR}`.
        for (const assignment of assignments) {
          assignment.apply({ ...assignment.ref });
        }
        const degradedOwner = createDegradedOwner(assignments, failureReason);
        degradedOwners.push(degradedOwner);
        warnDegradedSecretOwner(params.context, degradedOwner);
        continue;
      }
      if (
        assignments.every((assignment) => resolution.resolved.has(secretRefKey(assignment.ref)))
      ) {
        applyResolvedAssignments({ assignments, resolved: resolution.resolved });
        continue;
      }
      nextPendingOwners.push(assignments);
    }
    if (nextPendingOwners.length === pendingOwners.length) {
      throw toErrorObject(resolution.failures[0]?.error, "Secret resolution made no progress.");
    }
    pendingOwners = nextPendingOwners;
  }
  return degradedOwners;
}
