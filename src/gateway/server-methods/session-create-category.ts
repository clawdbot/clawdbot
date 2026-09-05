import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { sessionLog } from "./sessions-shared.js";

export function registerCreatedSessionCategory(
  category: string | undefined,
  context: Parameters<typeof emitSessionsChanged>[0],
): void {
  if (!category) {
    return;
  }
  try {
    if (ensureSessionGroupRegistered(category)) {
      // Catalog bookkeeping follows the authoritative session commit and has
      // its own invalidation. Its failure must not make a durable create ambiguous.
      emitSessionsChanged(context, { reason: "groups" });
    }
  } catch (error) {
    sessionLog.warn(`failed to register created session category: ${formatErrorMessage(error)}`);
  }
}
