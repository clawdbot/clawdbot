/**
 * Doctor contract for the copilot extension.
 *
 * Mirrors {@link ../codex/doctor-contract-api.ts} so `openclaw doctor`
 * can detect retired config fields and migrate them
 *     (legacyConfigRules + normalizeCompatibilityConfig). No retired
 *     fields exist for copilot yet; the array is empty by design
 *     and normalizeCompatibilityConfig is a structural no-op so
 *     future retirements have a stable in-tree home. Session-route ownership
 *     is static manifest metadata in openclaw.plugin.json.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

export const legacyConfigRules: LegacyConfigRule[] = [];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return { config: cfg, changes: [] };
}
