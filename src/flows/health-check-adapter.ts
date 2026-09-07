// Health check adapter converts plugin health checks into doctor check records.
import type { DoctorHealthCheck } from "./health-check-runner-types.js";

export function copyHealthCheck(check: DoctorHealthCheck): DoctorHealthCheck {
  return { ...check };
}

// Snapshot metadata now; method lookup and receiver remain owned by the input check.
export function normalizeHealthCheck(check: DoctorHealthCheck): DoctorHealthCheck {
  return {
    id: check.id,
    kind: check.kind,
    description: check.description,
    source: check.source,
    defaultEnabled: check.defaultEnabled,
    updateReadiness: check.updateReadiness,
    detect: (ctx, scope) => check.detect(ctx, scope),
    repair:
      check.repair === undefined
        ? undefined
        : (ctx, findings) => check.repair?.(ctx, findings) ?? Promise.resolve({ changes: [] }),
  };
}
