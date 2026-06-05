// Supervisor log runtime bridges supervisor events into subsystem logging.
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Runtime logging boundary for lazy supervisor paths and focused test mocks. */
const log = createSubsystemLogger("process/supervisor");

/** Report spawn failures without importing the full logging subsystem in tests. */
export function warnProcessSupervisorSpawnFailure(message: string) {
  log.warn(message);
}
