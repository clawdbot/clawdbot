import { normalizeOptionalString } from "../shared/string-coerce.js";

export function normalizeHeartbeatWakeReason(reason?: string): string {
  return normalizeOptionalString(reason) ?? "requested";
}
