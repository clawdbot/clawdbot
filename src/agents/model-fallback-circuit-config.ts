/**
 * Opt-in switch for the model route circuit breaker.
 *
 * The circuit changes which configured routes are attempted across turns, so
 * it stays off unless an operator asks for it. With it disabled the fallback
 * runner keeps its existing per-run cooldown and skip behavior untouched.
 */
import type { OpenClawConfig } from "../config/config.js";

export function isModelCircuitEnabled(cfg: OpenClawConfig | undefined): boolean {
  const model = cfg?.agents?.defaults?.model;
  if (!model || typeof model === "string") {
    return false;
  }
  return model.circuitBreaker?.enabled === true;
}
