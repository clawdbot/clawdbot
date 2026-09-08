import { workboardHost } from "../../host.ts";

export function normalizeSessionKeyForUiComparison(sessionKey: string): string {
  return workboardHost().sessions.normalizeKey(sessionKey);
}
