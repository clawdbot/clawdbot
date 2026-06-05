// Health check registry stores doctor health checks by identifier.
import type { HealthCheck } from "./health-checks.js";

// Process-local registry populated by core and plugin doctor checks.
const REGISTRY = new Map<string, HealthCheck>();

/** Raised when two checks claim the same stable health-check id. */
export class HealthCheckRegistrationError extends Error {
  readonly code = "OC_DOCTOR_DUPLICATE_CHECK";
  constructor(readonly checkId: string) {
    super(`health check already registered: ${checkId}`);
    this.name = "HealthCheckRegistrationError";
  }
}

/** Registers one health check for doctor lint/fix execution. */
export function registerHealthCheck(check: HealthCheck): void {
  if (REGISTRY.has(check.id)) {
    throw new HealthCheckRegistrationError(check.id);
  }
  REGISTRY.set(check.id, check);
}

/** Returns registered checks in insertion order for deterministic doctor output. */
export function listHealthChecks(): readonly HealthCheck[] {
  return [...REGISTRY.values()];
}

/** Looks up a registered health check by its stable id. */
export function getHealthCheck(id: string): HealthCheck | undefined {
  return REGISTRY.get(id);
}

/** Clears the process-local registry for isolated tests. */
export function clearHealthChecksForTest(): void {
  REGISTRY.clear();
}
