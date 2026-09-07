import { StartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";

/** Legacy history requires an explicit Doctor import, never automatic failure triage. */
export class SessionStoreMigrationRequiredError extends StartupMaintenanceRequiredError {
  override name = "SessionStoreMigrationRequiredError";

  constructor(message: string) {
    super("legacy-session-store", message);
  }
}
