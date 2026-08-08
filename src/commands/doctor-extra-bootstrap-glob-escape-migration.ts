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

// A single configured pattern's repair. `replace` overwrites the entry in place
// (the common case: the pattern was only ever a mislabeled literal). `add`
// appends the escaped literal ALONGSIDE the untouched original so a workspace
// that needs the literal path and another workspace whose live glob still
// matches can coexist — the loader unions results across patterns into a Set,
// so the extra entry is additive and safe.
type PatternRewrite =
  | { kind: "replace"; key: string; index: number; from: string; to: string }
  | { kind: "add"; key: string; from: string; to: string };

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

// Per-pattern escape decision. Two independent facts are computed across the
// full workspace set, because one hook config is shared by every agent while
// each agent has its own workspace:
//   - literalNeeded: some workspace has the literal path on disk (the brackets
//     were meant literally there);
//   - globLive: some workspace has >=1 real glob match (the pattern is a genuine
//     glob there today).
// The decision, once the pattern is an escapable glob (currently magic, and
// escaping fully removes its magic — brace `{a,b}` patterns stay magic and are
// left alone):
//   - neither          -> "none" (leave untouched, as today);
//   - literalNeeded only -> "replace" (rewrite in place to the escaped literal);
//   - literalNeeded + globLive -> "add" (keep the original glob AND add the
//     escaped literal, so neither workspace loses its file — a naive replace
//     would just move the silent-drop victim from one agent to the other).
// A globLive-only pattern is a real glob and is never escaped.
type EscapeDecision =
  | { action: "none" }
  | { action: "replace"; escaped: string }
  | { action: "add"; escaped: string };

async function decideExtraBootstrapEscape(
  pattern: string,
  workspaceDirs: string[],
): Promise<EscapeDecision> {
  if (!hasGlobPattern(pattern)) {
    return { action: "none" };
  }
  const escaped = escapeWorkspacePatternLiteral(pattern);
  if (escaped === pattern || hasGlobPattern(escaped)) {
    return { action: "none" };
  }
  let literalNeeded = false;
  let globLive = false;
  for (const workspaceDir of workspaceDirs) {
    let matches: string[];
    try {
      matches = await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false);
    } catch {
      // Unreadable branch: the pattern is ambiguous, so leave it untouched.
      return { action: "none" };
    }
    if (matches.length > 0) {
      globLive = true;
    }
    if (await pathExistsInside(workspaceDir, pattern)) {
      literalNeeded = true;
    }
  }
  if (!literalNeeded) {
    return { action: "none" };
  }
  return globLive ? { action: "add", escaped } : { action: "replace", escaped };
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
      const decision = await decideExtraBootstrapEscape(pattern, workspaceDirs);
      if (decision.action === "none" || decision.escaped === entry) {
        continue;
      }
      if (decision.action === "replace") {
        rewrites.push({ kind: "replace", key, index, from: entry, to: decision.escaped });
        continue;
      }
      // Coexistence add: skip when the escaped literal is already configured so a
      // second doctor run is idempotent and the list cannot grow unbounded.
      if (list.includes(decision.escaped)) {
        continue;
      }
      rewrites.push({ kind: "add", key, from: entry, to: decision.escaped });
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
      const preview =
        rewrite.kind === "add"
          ? `${rewrite.from} → keep, add ${rewrite.to}`
          : `${rewrite.from} → ${rewrite.to}`;
      note(preview, "Extra bootstrap glob escape preview");
    }
    return { cfg: params.cfg, changes: [], warnings: [] };
  }
  const next = structuredClone(params.cfg);
  const entries = next.hooks?.internal?.entries?.[HOOK_KEY] as Record<string, unknown> | undefined;
  const changes: string[] = [];
  if (entries) {
    for (const rewrite of rewrites) {
      const list = entries[rewrite.key];
      if (!Array.isArray(list)) {
        continue;
      }
      if (rewrite.kind === "replace") {
        list[rewrite.index] = rewrite.to;
        changes.push(`${rewrite.key}[${rewrite.index}]: ${rewrite.from} → ${rewrite.to}`);
        continue;
      }
      // Append the escaped literal beside the untouched original. Guard again on
      // the applied list so duplicate originals in one run cannot double-append.
      if (!list.includes(rewrite.to)) {
        list.push(rewrite.to);
        changes.push(`${rewrite.key}: + ${rewrite.to} (kept ${rewrite.from})`);
      }
    }
  }
  return { cfg: changes.length > 0 ? next : params.cfg, changes, warnings: [] };
}
