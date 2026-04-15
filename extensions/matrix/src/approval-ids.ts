import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";

export function normalizeMatrixApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixUserId(String(value));
  return normalized || undefined;
}
