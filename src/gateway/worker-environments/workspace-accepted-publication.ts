import { isRecord } from "@openclaw/normalization-core/record-coerce";

const SETTLEMENT_OUTCOMES = new Set(["begun", "rolled-back", "applied", "committed"]);

export type AcceptedWorkspaceSettlementOutcome = "begun" | "rolled-back" | "applied" | "committed";

export class AcceptedWorkspacePublicationIndeterminateError extends Error {
  override name = "AcceptedWorkspacePublicationIndeterminateError";
  readonly observationFailure!: unknown;

  constructor(
    readonly operation: "apply" | "commit",
    publicationFailure: unknown,
    observationFailure: unknown,
  ) {
    super("Accepted workspace publication is indeterminate and requires recovery", {
      cause: publicationFailure,
    });
    Object.defineProperty(this, "observationFailure", { value: observationFailure });
  }
}

export function isAcceptedWorkspacePublicationIndeterminateError(
  error: unknown,
): error is AcceptedWorkspacePublicationIndeterminateError {
  return error instanceof AcceptedWorkspacePublicationIndeterminateError;
}

export function parseAcceptedWorkspaceSettlement(
  stdout: string,
): AcceptedWorkspaceSettlementOutcome {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("Worker returned an invalid accepted workspace settlement outcome");
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!);
  } catch (error) {
    throw new Error("Worker returned an invalid accepted workspace settlement outcome", {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    typeof value.outcome !== "string" ||
    !SETTLEMENT_OUTCOMES.has(value.outcome)
  ) {
    throw new Error("Worker returned an invalid accepted workspace settlement outcome");
  }
  return value.outcome as AcceptedWorkspaceSettlementOutcome;
}
