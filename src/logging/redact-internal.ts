import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fullContextToolPayloadRedactionState } from "./redact-internal-state.js";

type LoggingConfig = OpenClawConfig["logging"];

export function isFullContextToolPayloadRedaction(loggingConfig: LoggingConfig): boolean {
  return fullContextToolPayloadRedactionState.isMarked(loggingConfig);
}
