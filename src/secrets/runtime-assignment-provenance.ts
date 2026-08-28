/** Internal provenance for assignments collected outside openclaw.json. */
import type { SecretAssignment } from "./runtime-shared.js";

type SecretAssignmentSource = "auth-store" | "config";

const assignmentSources = new WeakMap<SecretAssignment, SecretAssignmentSource>();

export function setSecretAssignmentSource(
  assignment: SecretAssignment,
  source: SecretAssignmentSource,
): void {
  assignmentSources.set(assignment, source);
}

export function getSecretAssignmentSource(assignment: SecretAssignment): SecretAssignmentSource {
  return assignmentSources.get(assignment) ?? "config";
}
