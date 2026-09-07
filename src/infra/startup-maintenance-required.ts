import { collectNestedErrorCandidates } from "./error-graph-internal.js";

export const GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON = "gateway.maintenance_required";

const maintenanceReasons = {
  "newer-schema": "a newer OpenClaw build",
  "agent-media": "offline media migration",
  "agent-databases-composite-primary-key": "state database schema migration",
  "audit-events-v2": "state database schema migration",
  "legacy-workspace": "workspace setup state migration",
  "legacy-session-store": "session store migration",
} as const;

export class StartupMaintenanceRequiredError extends Error {
  readonly code = GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON;

  constructor(
    readonly kind: keyof typeof maintenanceReasons,
    message: string,
  ) {
    super(message);
    this.name = "StartupMaintenanceRequiredError";
  }

  get reason(): string {
    return maintenanceReasons[this.kind];
  }
}

export function findStartupMaintenanceRequiredError(
  error: unknown,
): StartupMaintenanceRequiredError | undefined {
  const failures = collectNestedErrorCandidates(error).filter(
    (candidate): candidate is StartupMaintenanceRequiredError =>
      candidate instanceof StartupMaintenanceRequiredError,
  );
  // A repairable failure must not hide a database this build cannot open.
  return failures.find((failure) => failure.kind === "newer-schema") ?? failures[0];
}
