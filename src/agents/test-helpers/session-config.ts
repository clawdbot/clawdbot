import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Session config fixtures shared by agent/session tests.
 */
/** Builds a per-sender session config with optional targeted overrides. */
export function createPerSenderSessionConfig(
  overrides: Partial<NonNullable<OpenClawConfig["session"]>> = {},
): NonNullable<OpenClawConfig["session"]> {
  return {
    mainKey: "main",
    scope: "per-sender",
    ...overrides,
  };
}
