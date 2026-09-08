export function isTrustedHarnessOwnedUpgradeSurvivorScenario(scenario: string): boolean;
export function normalizeUpgradeSurvivorBaselineSpec(raw: string | undefined): string | undefined;
export function parseUpgradeSurvivorBaselineSpecs(raw: string | undefined): string[];
export function parseUpgradeSurvivorScenarios(raw: string | undefined): string[];
export function supportsUpgradeSurvivorScenarioAtBaseline(
  scenario: string | undefined,
  baselineSpec: string | undefined,
): boolean;
export const OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE: string;
