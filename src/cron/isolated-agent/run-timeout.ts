export function resolveCronRunTimeoutOverrideMs(timeoutSeconds: unknown): number | undefined {
  return typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? timeoutSeconds * 1000
    : undefined;
}
