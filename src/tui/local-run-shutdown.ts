import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

const LOCAL_RUN_SHUTDOWN_GRACE_MS = 120_000;

export function resolveLocalRunShutdownGraceMs(): number {
  const raw = process.env.OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS?.trim();
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return parsed;
  }
  return LOCAL_RUN_SHUTDOWN_GRACE_MS;
}
