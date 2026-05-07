import { recordTalkDiagnosticEvent } from "./diagnostics.js";
import { recordTalkLogEvent } from "./logging.js";
import type { TalkEvent } from "./talk-events.js";

export function recordTalkObservabilityEvent(event: TalkEvent): void {
  recordTalkDiagnosticEvent(event);
  recordTalkLogEvent(event);
}
