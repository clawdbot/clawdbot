const LOCAL_RUN_SHUTDOWN_GRACE_MS = 120_000;

export function resolveLocalRunShutdownGraceMs(): number {
  const raw = process.env.OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return LOCAL_RUN_SHUTDOWN_GRACE_MS;
}
