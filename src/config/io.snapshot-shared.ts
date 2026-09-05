import { observeConfigSnapshot } from "./io.observe.js";
import type { NormalizedConfigIoDeps, ReadConfigFileSnapshotInternalResult } from "./io.types.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "./materialize.js";
import { setConfigResolutionFacts, type ConfigResolutionFacts } from "./resolution-facts.js";
import type { ConfigFileSnapshot, LegacyConfigIssue, OpenClawConfig } from "./types.js";

export function createConfigFileSnapshot(params: {
  path: string;
  includedPaths?: readonly string[];
  includeProvenance?: ConfigFileSnapshot["includeProvenance"];
  agentRosterIncludeOwned?: boolean;
  bindingsIncludeOwned?: boolean;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  valid: boolean;
  runtimeConfig: OpenClawConfig;
  hash?: string;
  readError?: { code: string | null };
  issues: ConfigFileSnapshot["issues"];
  warnings: ConfigFileSnapshot["warnings"];
  legacyIssues: LegacyConfigIssue[];
  resolutionFacts?: ConfigResolutionFacts;
}): ConfigFileSnapshot {
  const sourceConfigBeforeMigrations = params.sourceConfigBeforeMigrations
    ? asResolvedSourceConfig(params.sourceConfigBeforeMigrations)
    : undefined;
  const sourceConfig = asResolvedSourceConfig(params.sourceConfig);
  const runtimeConfig = asRuntimeConfig(params.runtimeConfig);
  if (params.resolutionFacts !== undefined) {
    setConfigResolutionFacts(sourceConfigBeforeMigrations, params.resolutionFacts);
    setConfigResolutionFacts(sourceConfig, params.resolutionFacts);
    setConfigResolutionFacts(runtimeConfig, params.resolutionFacts);
  }
  return {
    path: params.path,
    includedPaths: [...(params.includedPaths ?? [])],
    ...(params.includeProvenance
      ? {
          includeProvenance: params.includeProvenance.map((entry) => ({
            ...entry,
            path: [...entry.path],
            ...(entry.targetPaths ? { targetPaths: [...entry.targetPaths] } : {}),
          })),
        }
      : {}),
    ...(params.agentRosterIncludeOwned !== undefined
      ? { agentRosterIncludeOwned: params.agentRosterIncludeOwned }
      : {}),
    ...(params.bindingsIncludeOwned !== undefined
      ? { bindingsIncludeOwned: params.bindingsIncludeOwned }
      : {}),
    exists: params.exists,
    raw: params.raw,
    parsed: params.parsed,
    ...(sourceConfigBeforeMigrations ? { sourceConfigBeforeMigrations } : {}),
    sourceConfig,
    resolved: sourceConfig,
    valid: params.valid,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    ...(params.readError ? { readError: params.readError } : {}),
    issues: params.issues,
    warnings: params.warnings,
    legacyIssues: params.legacyIssues,
  };
}

export async function finalizeReadConfigSnapshotInternalResult(
  deps: NormalizedConfigIoDeps,
  result: ReadConfigFileSnapshotInternalResult,
  options?: { observe?: boolean },
): Promise<ReadConfigFileSnapshotInternalResult> {
  if (deps.observe && options?.observe !== false) {
    await observeConfigSnapshot(deps, result.snapshot);
  }
  return result;
}

export async function collectInvalidConfigLegacyIssues(
  raw: unknown,
  sourceRaw: unknown,
): Promise<LegacyConfigIssue[]> {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const { findDoctorLegacyConfigIssues } =
    await import("../commands/doctor/shared/legacy-config-issues.js");
  return findDoctorLegacyConfigIssues(raw, sourceRaw);
}
