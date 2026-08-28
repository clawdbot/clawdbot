const repairableFailureDetails = new WeakSet<object>();

/** Attach host-only repair authority to one finalized Code Mode failure payload. */
export function registerRepairableCodeModeFailure(details: object): void {
  repairableFailureDetails.add(details);
}

/** Consume repair authority from the exact host-created failure payload. */
export function consumeRepairableCodeModeFailure(details: unknown): boolean {
  return (
    typeof details === "object" && details !== null && repairableFailureDetails.delete(details)
  );
}
