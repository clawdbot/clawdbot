/** Doctor-owned migration from workspace TOOLS.md into the AGENTS.md Tools section. */
import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch, minimatch } from "minimatch";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  loadWorkspacePatternFilesWithDiagnostics,
} from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  resolveExtraBootstrapPatternConfig,
  resolveExtraBootstrapPatterns,
} from "../hooks/bundled/bootstrap-extra-files/patterns.js";
import { resolveHookConfig } from "../hooks/config.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { shortenHomePath } from "../utils.js";
import {
  migrateToolsMdSource,
  readToolsMd,
  sha256,
  TOOLS_CLAIM_INFIX,
  type ToolsMdSource,
} from "./doctor-tools-md-files.js";

const TOOLS_MD_MIGRATION_CHECK_ID = "core/doctor/tools-md-migration";
const TOOLS_MD_PATTERN_BASENAMES = new Set([DEFAULT_TOOLS_FILENAME]);

type ToolsMdMigrationResult = {
  changes: string[];
  warnings: string[];
};

function workspaceTargets(cfg: OpenClawConfig): Array<{ agentId: string; workspaceDir: string }> {
  const seen = new Set<string>();
  return listAgentIds(cfg).flatMap((agentId) => {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = path.resolve(workspaceDir);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ agentId, workspaceDir }];
  });
}

function configuredExtraBootstrapPatterns(cfg: OpenClawConfig): string[] {
  const hookConfig = resolveHookConfig(cfg, "bootstrap-extra-files");
  if (!hookConfig || hookConfig.enabled === false) {
    return [];
  }
  return resolveExtraBootstrapPatterns(hookConfig as Record<string, unknown>);
}

const WORKSPACE_GLOB_OPTIONS = {
  nocomment: true,
  nonegate: true,
  windowsPathsNoEscape: true,
} as const;

function patternAlternativesMatchingBasename(pattern: string, basename: string): string[] {
  const normalized = pattern.replaceAll(path.sep, "/").replaceAll("\\", "/");
  const matcher = new Minimatch(normalized, WORKSPACE_GLOB_OPTIONS);
  return matcher.globSet.filter((alternative) =>
    minimatch(basename, path.posix.basename(alternative), WORKSPACE_GLOB_OPTIONS),
  );
}

function patternCanMatchToolsMd(pattern: string): boolean {
  return patternAlternativesMatchingBasename(pattern, DEFAULT_TOOLS_FILENAME).length > 0;
}

function interruptedClaimPatterns(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => {
    const claimName = `${DEFAULT_TOOLS_FILENAME}${TOOLS_CLAIM_INFIX}*`;
    return patternAlternativesMatchingBasename(pattern, DEFAULT_TOOLS_FILENAME).map(
      (alternative) => {
        const basenamePattern = path.posix.basename(alternative);
        if (basenamePattern === "**") {
          return `${alternative}/${claimName}`;
        }
        const dirnamePattern = path.posix.dirname(alternative);
        return dirnamePattern === "." ? claimName : `${dirnamePattern}/${claimName}`;
      },
    );
  });
}

function patternAlternativeStaysInsideWorkspace(alternative: string): boolean {
  const normalized = path.posix.normalize(alternative);
  return (
    !path.posix.isAbsolute(normalized) &&
    !path.win32.isAbsolute(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function agentsPatternsForToolsPattern(pattern: string): string[] {
  const normalized = pattern.replaceAll(path.sep, "/").replaceAll("\\", "/");
  const expandedPatterns = new Set(new Minimatch(normalized, WORKSPACE_GLOB_OPTIONS).globSet);
  return patternAlternativesMatchingBasename(pattern, DEFAULT_TOOLS_FILENAME).flatMap(
    (alternative) => {
      if (!patternAlternativeStaysInsideWorkspace(alternative)) {
        return [];
      }
      const basenamePattern = path.posix.basename(alternative);
      if (minimatch(DEFAULT_AGENTS_FILENAME, basenamePattern, WORKSPACE_GLOB_OPTIONS)) {
        return [];
      }
      const dirnamePattern = path.posix.dirname(alternative);
      const agentsPattern =
        dirnamePattern === "."
          ? DEFAULT_AGENTS_FILENAME
          : `${dirnamePattern}/${DEFAULT_AGENTS_FILENAME}`;
      return expandedPatterns.has(agentsPattern) ? [] : [agentsPattern];
    },
  );
}

function retargetConfiguredExtraBootstrapPatterns(cfg: OpenClawConfig): string[] {
  const hookConfig = resolveHookConfig(cfg, "bootstrap-extra-files");
  if (!hookConfig) {
    return [];
  }
  const resolved = resolveExtraBootstrapPatternConfig(hookConfig as Record<string, unknown>);
  if (!resolved) {
    return [];
  }
  const additions = [
    ...new Set(
      resolved.patterns
        .flatMap((pattern) => agentsPatternsForToolsPattern(pattern))
        .filter((pattern) => !resolved.patterns.includes(pattern)),
    ),
  ];
  if (additions.length === 0) {
    return [];
  }
  hookConfig[resolved.key] = [...resolved.patterns, ...additions];
  return additions;
}

async function collectWorkspaceToolsMdSources(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  recoverClaims: boolean;
}): Promise<ToolsMdSource[]> {
  const sources: ToolsMdSource[] = [];
  const seen = new Set<string>();
  const rootSource = await readToolsMd(params.workspaceDir, {
    recoverClaims: params.recoverClaims,
  });
  if (rootSource) {
    sources.push(rootSource);
    seen.add(await fs.realpath(rootSource.path));
  }

  const patterns = configuredExtraBootstrapPatterns(params.cfg);
  const toolsPatterns = patterns.filter(patternCanMatchToolsMd);
  if (toolsPatterns.length === 0) {
    return sources;
  }
  const resolved = await loadWorkspacePatternFilesWithDiagnostics(
    params.workspaceDir,
    toolsPatterns,
    {
      acceptedBasenames: TOOLS_MD_PATTERN_BASENAMES,
      reportUnsupportedBasenames: false,
      strictPatternRead: true,
    },
  );
  const claimMatches = await loadWorkspacePatternFilesWithDiagnostics(
    params.workspaceDir,
    interruptedClaimPatterns(toolsPatterns),
    {
      acceptedBasenames: new Set(),
      acceptedBasenamePrefixes: [`${DEFAULT_TOOLS_FILENAME}${TOOLS_CLAIM_INFIX}`],
      reportUnsupportedBasenames: false,
      strictPatternRead: true,
    },
  );
  const blocked = [...resolved.diagnostics, ...claimMatches.diagnostics].filter(
    (diagnostic) => diagnostic.reason === "security" || diagnostic.reason === "io",
  );
  if (blocked.length > 0) {
    throw new Error(
      `bootstrap-extra-files patterns could not be read safely: ${blocked
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.detail}`)
        .join("; ")}`,
    );
  }
  const matchedFiles = [...resolved.files, ...claimMatches.files];
  if (matchedFiles.length === 0) {
    return sources;
  }

  const workspaceRealPath = await fs.realpath(params.workspaceDir);
  const candidateDirectories = new Map<string, Set<string>>();
  for (const matched of matchedFiles) {
    const stat = await fs.lstat(matched.path);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `configured TOOLS.md migration source must not be a symlink: ${matched.path}`,
      );
    }
    const matchedRealPath = await fs.realpath(matched.path);
    if (!isPathInside(workspaceRealPath, matchedRealPath)) {
      throw new Error(`configured TOOLS.md resolved outside the workspace: ${matched.path}`);
    }
    const sourceDir = path.dirname(matchedRealPath);
    const expectedHashes = candidateDirectories.get(sourceDir) ?? new Set<string>();
    expectedHashes.add(sha256(matched.content));
    candidateDirectories.set(sourceDir, expectedHashes);
  }
  for (const [sourceDir, expectedHashes] of candidateDirectories) {
    const source = await readToolsMd(sourceDir, {
      recoverClaims: params.recoverClaims,
    });
    if (!source) {
      throw new Error(`configured TOOLS.md changed during migration discovery: ${sourceDir}`);
    }
    const sourceRealPath = await fs.realpath(source.path);
    if (seen.has(sourceRealPath)) {
      continue;
    }
    if (!expectedHashes.has(source.sha256)) {
      throw new Error(`configured TOOLS.md changed during migration discovery: ${source.path}`);
    }
    seen.add(sourceRealPath);
    sources.push({ ...source, fromExtraPattern: true });
  }
  return sources;
}

function migrationFinding(params: {
  agentId: string;
  path: string;
  message: string;
  severity?: HealthFinding["severity"];
  requirement: string;
}): HealthFinding {
  return {
    checkId: TOOLS_MD_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.path,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to merge TOOLS.md into AGENTS.md.`,
  };
}

export async function collectToolsMdMigrationFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  for (const target of workspaceTargets(cfg)) {
    try {
      const sources = await collectWorkspaceToolsMdSources({
        cfg,
        workspaceDir: target.workspaceDir,
        recoverClaims: false,
      });
      for (const source of sources) {
        findings.push(
          migrationFinding({
            agentId: target.agentId,
            path: source.path,
            message: `Agent "${target.agentId}" still stores local tool notes in TOOLS.md.`,
            requirement: "legacy-tools-md",
          }),
        );
      }
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: target.agentId,
          path: path.join(target.workspaceDir, DEFAULT_TOOLS_FILENAME),
          message: `Agent "${target.agentId}" TOOLS.md cannot be migrated: ${errorMessage(error)}`,
          severity: "error",
          requirement: "tools-md-migration-blocked",
        }),
      );
    }
  }
  return findings;
}

export async function maybeMigrateToolsMd(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ToolsMdMigrationResult> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  let migrationBlocked = false;
  let migratedConfiguredSource = false;
  for (const target of workspaceTargets(params.cfg)) {
    let sources: ToolsMdSource[];
    try {
      sources = await collectWorkspaceToolsMdSources({
        cfg: params.cfg,
        workspaceDir: target.workspaceDir,
        recoverClaims: params.shouldRepair,
      });
    } catch (error) {
      warnings.push(`Agent "${target.agentId}" TOOLS.md was not migrated: ${errorMessage(error)}`);
      migrationBlocked = true;
      continue;
    }
    if (!params.shouldRepair) {
      for (const source of sources) {
        note(
          `${shortenHomePath(source.path)} will be archived and merged into AGENTS.md when customized.`,
          "TOOLS.md migration preview",
        );
      }
      continue;
    }

    for (const source of sources.toSorted((left, right) => left.path.localeCompare(right.path))) {
      try {
        const migrated = await migrateToolsMdSource({
          agentId: target.agentId,
          source,
          workspaceDir: target.workspaceDir,
          env,
        });
        changes.push(
          migrated.shouldMerge
            ? `Merged ${shortenHomePath(source.path)} into ${shortenHomePath(migrated.agentsPath)} and archived the original.`
            : `Removed untouched ${shortenHomePath(source.path)} after archiving it.`,
        );
        migratedConfiguredSource ||= source.fromExtraPattern === true;
      } catch (error) {
        warnings.push(
          `Agent "${target.agentId}" ${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}`,
        );
        migrationBlocked = true;
        break;
      }
    }
  }
  if (params.shouldRepair && (!migrationBlocked || migratedConfiguredSource)) {
    const additions = retargetConfiguredExtraBootstrapPatterns(params.cfg);
    if (additions.length > 0) {
      changes.push(
        `Added migrated AGENTS.md bootstrap pattern${additions.length === 1 ? "" : "s"}: ${additions.join(", ")}`,
      );
    }
  }
  if (changes.length > 0) {
    note(changes.join("\n"), "TOOLS.md migration");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
