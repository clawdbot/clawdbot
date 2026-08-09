import type { OpenClawConfig } from "./types.openclaw.js";

/** Builds the canonical config owned by a genuinely fresh, missing-file install. */
export function createFreshOpenClawConfig(): OpenClawConfig {
  return { agents: { entries: { main: { default: true } } } };
}
