// Doctor migration: escape literal bracket/extglob characters in configured
// extra-bootstrap-file glob patterns.
//
// The bootstrap-extra-files walker adopted full Node glob grammar, so a pattern
// like `pkg[ab]/AGENTS.md` — written before the change to name a real directory
// literally called `pkg[ab]` — is now parsed as a character class and silently
// stops loading. This `openclaw doctor --fix` migration detects patterns whose
// bracket/extglob syntax was almost certainly meant literally (the literal path
// exists on disk in an agent workspace, and the pattern matches nothing as a
// glob) and rewrites them to their escaped literal form (`pkg[[]ab[]]/…`). The
// escaped form is magic-free, so the loader routes it through the literal reader
// which unescapes it back to the real on-disk path (see
// unescapeWorkspacePatternLiteral in the walker module).
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  escapeWorkspacePatternLiteral,
  hasGlobPattern,
  resolveExtraBootstrapPatternPaths,
} from "../agents/workspace-extra-bootstrap-walker.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveHookConfig } from "../hooks/config.js";
import { isPathInside } from "../infra/path-guards.js";

const CHECK_ID = "core/doctor/extra-bootstrap-glob-escape";
const HOOK_KEY = "bootstrap-extra-files";
// Config keys the bootstrap-extra-files hook reads patterns from; all are
// rewritten so the fix holds regardless of which key the hook currently prefers.
const PATTERN_KEYS = ["paths", "patterns", "files"] as const;

type PatternRewrite = { key: string; index: number; from: string; to: string };

type ExtraBootstrapGlobEscapeResult = {
  cfg: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

// Deduped set of agent workspace directories the patterns resolve against. The
// hook config is global but workspaces are per-agent, so a literal path only has
// to exist in one of them for the escape to be warranted.
function agentWorkspaceDirs(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const dirs = new Set<string>();
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId, env));
  }
  return [...dirs];
}

async function pathExistsInside(workspaceDir: string, relPattern: string): Promise<boolean> {
  const literalAbs = path.resolve(workspaceDir, relPattern);
  if (!isPathInside(workspaceDir, literalAbs)) {
    return false;
  }
  try {
    await fs.stat(literalAbs);
    return true;
  } catch {
    return false;
  }
}

// Decide the escaped form for a single configured pattern, or null to leave it
// untouched. A pattern is escaped only when all of the following hold, so a
// genuine glob is never rewritten:
//   1. it is currently parsed as a glob (`[ab]`, `@(a|b)`, …);
//   2. escaping fully removes its magic (brackets/extglobs collapse to literals;
//      brace `{a,b}` patterns stay magic and are intentionally left alone);
//   3. it matches nothing as a glob in every workspace; and
//   4. its literal interpretation names an existing on-disk entry in some
//      workspace — the signal that the brackets were meant literally.
async function escapedLiteralPatternOrNull(
  pattern: string,
  workspaceDirs: string[],
): Promise<string | null> {
  if (!hasGlobPattern(pattern)) {
    return null;
  }
  const escaped = escapeWorkspacePatternLiteral(pattern);
  if (escaped === pattern || hasGlobPattern(escaped)) {
    return null;
  }
  for (const workspaceDir of workspaceDirs) {
    let matches: string[];
    try {
      matches = await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false);
    } catch {
      // Unreadable branch: the pattern is ambiguous, so leave it untouched.
      return null;
    }
    if (matches.length > 0) {
      // Real glob (matches files today) — never escape it.
      return null;
    }
  }
  for (const workspaceDir of workspaceDirs) {
    if (await pathExistsInside(workspaceDir, pattern)) {
      return escaped;
    }
  }
  return null;
}

async function computeExtraBootstrapGlobEscapes(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<PatternRewrite[]> {
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return [];
  }
  const workspaceDirs = agentWorkspaceDirs(cfg, env);
  if (workspaceDirs.length === 0) {
    return [];
  }
  const rewrites: PatternRewrite[] = [];
  const hookRecord = hookConfig as Record<string, unknown>;
  for (const key of PATTERN_KEYS) {
    const list = hookRecord[key];
    if (!Array.isArray(list)) {
      continue;
    }
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (typeof entry !== "string") {
        continue;
      }
      const pattern = entry.trim();
      if (!pattern) {
        continue;
      }
      const escaped = await escapedLiteralPatternOrNull(pattern, workspaceDirs);
      if (escaped !== null && escaped !== entry) {
        rewrites.push({ key, index, from: entry, to: escaped });
      }
    }
  }
  return rewrites;
}

export async function collectExtraBootstrapGlobEscapeFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const rewrites = await computeExtraBootstrapGlobEscapes(cfg, env);
  return rewrites.map((rewrite) => ({
    checkId: CHECK_ID,
    severity: "warning",
    message: `Bootstrap pattern "${rewrite.from}" now reads its bracket/extglob characters as a glob and no longer loads the literal path.`,
    requirement: "extra-bootstrap-literal-glob-escape",
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to escape literal bracket/extglob characters in bootstrap-extra-files patterns.`,
  }));
}

export async function maybeEscapeExtraBootstrapGlobs(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ExtraBootstrapGlobEscapeResult> {
  const env = params.env ?? process.env;
  const rewrites = await computeExtraBootstrapGlobEscapes(params.cfg, env);
  if (rewrites.length === 0) {
    return { cfg: params.cfg, changes: [], warnings: [] };
  }
  if (!params.shouldRepair) {
    for (const rewrite of rewrites) {
      note(`${rewrite.from} → ${rewrite.to}`, "Extra bootstrap glob escape preview");
    }
    return { cfg: params.cfg, changes: [], warnings: [] };
  }
  const next = structuredClone(params.cfg);
  const entries = next.hooks?.internal?.entries?.[HOOK_KEY] as Record<string, unknown> | undefined;
  const changes: string[] = [];
  if (entries) {
    for (const rewrite of rewrites) {
      const list = entries[rewrite.key];
      if (Array.isArray(list)) {
        list[rewrite.index] = rewrite.to;
        changes.push(`${rewrite.key}[${rewrite.index}]: ${rewrite.from} → ${rewrite.to}`);
      }
    }
  }
  return { cfg: changes.length > 0 ? next : params.cfg, changes, warnings: [] };
}
