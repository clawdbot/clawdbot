/**
 * Doctor contract for the copilot extension.
 *
 * Mirrors {@link ../codex/doctor-contract-api.ts} so `openclaw doctor`
 * can:
 *   - Reason about which session-state belongs to this extension
 *     (sessionRouteStateOwners) for cleanup of stale state across
 *     runtime swaps.
 *   - Detect retired config fields and migrate them
 *     (legacyConfigRules + normalizeCompatibilityConfig). No retired
 *     fields exist for copilot yet; the array is empty by design
 *     and normalizeCompatibilityConfig is a structural no-op so
 *     future retirements have a stable in-tree home.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

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

/**
 * Session-state ownership claim for the copilot agent runtime.
 *
 * - id / label: Identify the extension in doctor output.
 * - providerIds: The subscription Copilot providers.
 * - runtimeIds: Our harness id (matches harness.ts `id` field).
 * - cliSessionKeys: Session keys this harness writes; doctor uses
 *   this when pruning stale CLI session state.
 * - authProfilePrefixes: Conventional prefix for any auth profile
 *   created/consumed by this extension.
 */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "copilot",
    label: "GitHub Copilot agent runtime",
    providerIds: ["github-copilot"],
    runtimeIds: ["copilot"],
    cliSessionKeys: ["copilot"],
    authProfilePrefixes: ["github-copilot:"],
  },
];
