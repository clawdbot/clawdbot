type TraceDetails = Record<string, boolean | number | string | undefined>;

function isPluginLifecycleTraceEnabled(): boolean {
  const raw = process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function formatTraceValue(value: boolean | number | string): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function emitPluginLifecycleTrace(params: {
  phase: string;
  start: bigint;
  status: "error" | "ok";
  details?: TraceDetails;
}): void {
  const elapsedMs = Number(process.hrtime.bigint() - params.start) / 1_000_000;
  const detailText = Object.entries(params.details ?? {})
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatTraceValue(value)}`)
    .join(" ");
  const suffix = detailText ? ` ${detailText}` : "";
  console.error(
    `[plugins:lifecycle] phase=${JSON.stringify(params.phase)} ms=${elapsedMs.toFixed(2)} status=${params.status}${suffix}`,
  );
}

export function tracePluginLifecyclePhase<T>(
  phase: string,
  fn: () => T,
  details?: TraceDetails,
): T {
  if (!isPluginLifecycleTraceEnabled()) {
    return fn();
  }
  const start = process.hrtime.bigint();
  let status: "error" | "ok" = "error";
  try {
    const result = fn();
    status = "ok";
    return result;
  } finally {
    emitPluginLifecycleTrace({ phase, start, status, details });
  }
}

export async function tracePluginLifecyclePhaseAsync<T>(
  phase: string,
  fn: () => Promise<T>,
  details?: TraceDetails,
): Promise<T> {
  if (!isPluginLifecycleTraceEnabled()) {
    return fn();
  }
  const start = process.hrtime.bigint();
  let status: "error" | "ok" = "error";
  try {
    const result = await fn();
    status = "ok";
    return result;
  } finally {
    emitPluginLifecycleTrace({ phase, start, status, details });
  }
}
