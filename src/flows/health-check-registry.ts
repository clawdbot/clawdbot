import type { HealthCheck } from "./health-checks.js";

const REGISTRY = new Map<string, HealthCheck>();

export class HealthCheckRegistrationError extends Error {
  readonly code = "OC_DOCTOR_DUPLICATE_CHECK";
  constructor(readonly checkId: string) {
    super(`health check already registered: ${checkId}`);
    this.name = "HealthCheckRegistrationError";
  }
}

export function registerHealthCheck(check: HealthCheck): void {
  if (REGISTRY.has(check.id)) {
    throw new HealthCheckRegistrationError(check.id);
  }
  REGISTRY.set(check.id, check);
}

export function listHealthChecks(): readonly HealthCheck[] {
  return [...REGISTRY.values()];
}

export function getHealthCheck(id: string): HealthCheck | undefined {
  return REGISTRY.get(id);
}

export function clearHealthChecksForTest(): void {
  REGISTRY.clear();
}
