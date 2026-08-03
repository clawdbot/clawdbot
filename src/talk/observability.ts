/**
 * Combined Talk observability hook for relays and SDK consumers.
 *
 * A single Talk event should feed both trusted diagnostics and structured logs;
 * this facade keeps relay call sites from choosing only one path.
 */
import { recordTalkDiagnosticEvent } from "./diagnostics.js";
import { recordTalkLogEvent } from "./logging.js";
import type { TalkEvent } from "./talk-events.js";

/** Record one Talk event through diagnostics and logging projections. */
export function recordTalkObservabilityEvent(event: TalkEvent): void {
  recordTalkDiagnosticEvent(event);
  recordTalkLogEvent(event);
}
