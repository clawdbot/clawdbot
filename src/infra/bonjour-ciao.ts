import { logDebug } from "../logger.js";

import { formatBonjourError } from "./bonjour-errors.js";

export function ignoreCiaoCancellationRejection(reason: unknown): boolean {
  const message = formatBonjourError(reason).toUpperCase();
  if (!message.includes("CIAO ANNOUNCEMENT CANCELLED")) {
    return false;
  }
  logDebug(
    `bonjour: ignoring unhandled ciao rejection: ${formatBonjourError(reason)}`,
  );
  return true;
}
