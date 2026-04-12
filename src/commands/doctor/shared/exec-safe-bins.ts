import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCommandResolutionFromArgv } from "../../../infra/exec-command-resolution.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../../../infra/exec-safe-bin-runtime-policy.js";
import { listRiskyConfiguredSafeBins } from "../../../infra/exec-safe-bin-semantics.js";
import {
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  normalizeTrustedSafeBinDirs,
} from "../../../infra/exec-safe-bin-trust.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

export type ExecSafeBinCoverageHit = {
  scopePath: string;
  bin: string;
  kind: "missingProfile" | "riskySemantics";
  isInterpreter?: boolean;
  warning?: string;
};

type ExecSafeBinScopeRef = {
  scopePath: string;
  safeBins: string[];
  exec: Record<string, unknown>;
  mergedProfiles: Record<string, unknown>;
  trustedSafeBinDirs: ReadonlySet<string>;
};

export type ExecSafeBinTrustedDirHintHit = {
  scopePath: string;
  bin: string;
  resolvedPath: string;
};

function normalizeConfiguredSafeBins(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => normalizeOptionalLowercaseString(entry) ?? "")
        .filter((entry) => entry.length > 0),
    ),
  ).toSorted();
}

function normalizeConfiguredTrustedSafeBinDirs(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return normalizeTrustedSafeBinDirs(
    entries.filter((entry): entry is string => typeof entry === "string"),
  );
}

function collectExecSafeBinScopes(cfg: OpenClawConfig): ExecSafeBinScopeRef[] {
  const scopes: ExecSafeBinScopeRef[] = [];
  const globalExec = asObjectRecord(cfg.tools?.exec);
  const globalTrustedDirs = normalizeConfiguredTrustedSafeBinDirs(globalExec?.safeBinTrustedDirs);
  if (globalExec) {
    const safeBins = normalizeConfiguredSafeBins(globalExec.safeBins);
    if (safeBins.length > 0) {
      scopes.push({
        scopePath: "tools.exec",
        safeBins,
        exec: globalExec,
        mergedProfiles:
          resolveMergedSafeBinProfileFixtures({
            global: globalExec,
          }) ?? {},
        trustedSafeBinDirs: getTrustedSafeBinDirs({
          extraDirs: globalTrustedDirs,
        }),
      });
    }
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    const agentExec = asObjectRecord(agent.tools?.exec);
    if (!agentExec) {
      continue;
    }
    const safeBins = normalizeConfiguredSafeBins(agentExec.safeBins);
    if (safeBins.length === 0) {
      continue;
    }
    scopes.push({
      scopePath: `agents.list.${agent.id}.tools.exec`,
      safeBins,
      exec: agentExec,
      mergedProfiles:
        resolveMergedSafeBinProfileFixtures({
          global: globalExec,
          local: agentExec,
        }) ?? {},
      trustedSafeBinDirs: getTrustedSafeBinDirs({
        extraDirs: [
          ...globalTrustedDirs,
          ...normalizeConfiguredTrustedSafeBinDirs(agentExec.safeBinTrustedDirs),
        ],
      }),
    });
  }
  return scopes;
}

export function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[] {
  const hits: ExecSafeBinCoverageHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    for (const bin of scope.safeBins) {
      if (scope.mergedProfiles[bin]) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        kind: "missingProfile",
        isInterpreter: interpreterBins.has(bin),
      });
    }
    for (const hit of listRiskyConfiguredSafeBins(scope.safeBins)) {
      hits.push({
        scopePath: scope.scopePath,
        bin: hit.bin,
        kind: "riskySemantics",
        warning: hit.warning,
      });
    }
  }
  return hits;
}

export function scanExecSafeBinTrustedDirHints(
  cfg: OpenClawConfig,
): ExecSafeBinTrustedDirHintHit[] {
  const hits: ExecSafeBinTrustedDirHintHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    for (const bin of scope.safeBins) {
      const resolution = resolveCommandResolutionFromArgv([bin]);
      if (!resolution?.execution.resolvedPath) {
        continue;
      }
      if (
        isTrustedSafeBinPath({
          resolvedPath: resolution.execution.resolvedPath,
          trustedDirs: scope.trustedSafeBinDirs,
        })
      ) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        resolvedPath: resolution.execution.resolvedPath,
      });
    }
  }
  return hits;
}

export function collectExecSafeBinCoverageWarnings(params: {
  hits: ExecSafeBinCoverageHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const interpreterHits = params.hits.filter(
    (hit) => hit.kind === "missingProfile" && hit.isInterpreter,
  );
  const customHits = params.hits.filter(
    (hit) => hit.kind === "missingProfile" && !hit.isInterpreter,
  );
  const riskyHits = params.hits.filter((hit) => hit.kind === "riskySemantics");
  const lines: string[] = [];
  if (interpreterHits.length > 0) {
    for (const hit of interpreterHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBins includes interpreter/runtime '${sanitizeForLog(hit.bin)}' without profile.`,
      );
    }
    if (interpreterHits.length > 5) {
      lines.push(
        `- ${interpreterHits.length - 5} more interpreter/runtime safeBins entries are missing profiles.`,
      );
    }
  }
  if (customHits.length > 0) {
    for (const hit of customHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' is missing safeBinProfiles.${sanitizeForLog(hit.bin)}.`,
      );
    }
    if (customHits.length > 5) {
      lines.push(`- ${customHits.length - 5} more custom safeBins entries are missing profiles.`);
    }
  }
  if (riskyHits.length > 0) {
    for (const hit of riskyHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBins includes '${sanitizeForLog(hit.bin)}': ${sanitizeForLog(hit.warning ?? "prefer explicit allowlist entries or approval-gated runs.")}`,
      );
    }
    if (riskyHits.length > 5) {
      lines.push(
        `- ${riskyHits.length - 5} more safeBins entries should not use the low-risk safeBins fast path.`,
      );
    }
  }
  lines.push(
    `- Run "${params.doctorFixCommand}" to scaffold missing custom safeBinProfiles entries.`,
  );
  return lines;
}

export function collectExecSafeBinTrustedDirHintWarnings(
  hits: ExecSafeBinTrustedDirHintHit[],
): string[] {
  if (hits.length === 0) {
    return [];
  }
  const lines = hits
    .slice(0, 5)
    .map(
      (hit) =>
        `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' resolves to '${sanitizeForLog(hit.resolvedPath)}' outside trusted safe-bin dirs.`,
    );
  if (hits.length > 5) {
    lines.push(`- ${hits.length - 5} more safeBins entries resolve outside trusted safe-bin dirs.`);
  }
  lines.push(
    "- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).",
  );
  return lines;
}

export function maybeRepairExecSafeBinProfiles(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const next = structuredClone(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];

  for (const scope of collectExecSafeBinScopes(next)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    for (const hit of listRiskyConfiguredSafeBins(scope.safeBins)) {
      warnings.push(`- ${scope.scopePath}.safeBins includes '${hit.bin}': ${hit.warning}`);
    }
    const missingBins = scope.safeBins.filter((bin) => !scope.mergedProfiles[bin]);
    if (missingBins.length === 0) {
      continue;
    }
    const profileHolder =
      asObjectRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
    for (const bin of missingBins) {
      if (interpreterBins.has(bin)) {
        warnings.push(
          `- ${scope.scopePath}.safeBins includes interpreter/runtime '${bin}' without profile; remove it from safeBins or use explicit allowlist entries.`,
        );
        continue;
      }
      if (profileHolder[bin] !== undefined) {
        continue;
      }
      profileHolder[bin] = {};
      changes.push(
        `- ${scope.scopePath}.safeBinProfiles.${bin}: added scaffold profile {} (review and tighten flags/positionals).`,
      );
    }
  }

  if (changes.length === 0 && warnings.length === 0) {
    return { config: cfg, changes: [], warnings: [] };
  }
  return { config: next, changes, warnings };
}
