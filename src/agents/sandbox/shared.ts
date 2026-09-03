/**
 * Shared sandbox naming and scope helpers.
 *
 * Produces stable session slugs, workspace directories, and registry scope keys.
 */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentIdFromSessionKey } from "../agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { hashTextSha256 } from "./hash.js";
import type { SandboxConfig, SandboxIsolationSubject } from "./types.js";
import { resolveMaterializedSandboxSkillsWorkspaceDir } from "./workspace-mounts.js";

const WORKSPACE_SCOPE_SUFFIX_RE = /:workspace:[a-f0-9]{32}$/i;
const WORKSPACE_RUNTIME_SLUG_RE = /^workspace-[a-f0-9]{32}$/i;

/** Converts an arbitrary session key into a bounded filesystem/container-safe slug. */
export function slugifySessionKey(value: string) {
  const trimmed = value.trim() || "session";
  if (WORKSPACE_SCOPE_SUFFIX_RE.test(trimmed)) {
    return `workspace-${hashTextSha256(trimmed).slice(0, 32)}`;
  }
  const hash = hashTextSha256(trimmed).slice(0, 8);
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = safe.slice(0, 32) || "session";
  return `${base}-${hash}`;
}

/** Builds a bounded Docker name without truncating the scope-identity slug. */
export function buildSandboxContainerName(prefix: string, slug: string): string {
  const maxLength = 63;
  const fullName = `${prefix}${slug}`;
  if (fullName.length <= maxLength) {
    return fullName;
  }
  if (WORKSPACE_RUNTIME_SLUG_RE.test(slug)) {
    // Preserve all 128 scope bits. Only the prefix is shortened, while the
    // trailing hash keeps custom prefixes distinct when Docker's limit applies.
    const identitySuffix = `-${slug}-${hashTextSha256(fullName).slice(0, 12)}`;
    const prefixBudget = maxLength - identitySuffix.length;
    const boundedPrefix = prefix.slice(0, prefixBudget);
    return `${boundedPrefix}${identitySuffix}`;
  }
  const identitySuffix = `-${hashTextSha256(fullName).slice(0, 12)}`;
  return `${fullName.slice(0, maxLength - identitySuffix.length)}${identitySuffix}`;
}

/** Resolves the per-session sandbox workspace directory under the configured sandbox root. */
function resolveSandboxWorkspaceDir(root: string, sessionKey: string) {
  const resolvedRoot = resolveUserPath(root);
  const slug = slugifySessionKey(sessionKey);
  return path.join(resolvedRoot, slug);
}

/** Resolves workspace-qualified registry identity for non-shared sandbox lifetimes. */
function resolveSandboxScopeKey(
  scope: "session" | "agent" | "shared",
  sessionKey: string,
  workspaceDir: string,
  agentId?: string,
  isolationSubject?: SandboxIsolationSubject,
) {
  const trimmed = sessionKey.trim() || "main";
  if (scope === "shared" && !isolationSubject) {
    return "shared";
  }
  // Co-hosted workspaces may reuse agent and session keys, but must never
  // converge on one runtime, registry entry, or materialized skills workspace.
  const workspaceSuffix = `:workspace:${hashTextSha256(resolveUserPath(workspaceDir)).slice(0, 32)}`;
  if (isolationSubject) {
    const resolvedAgentId = agentId
      ? normalizeAgentId(agentId)
      : resolveAgentIdFromSessionKey(trimmed);
    // Preserve existing profile paths. Other creators cannot adopt a profile's resources,
    // even when their raw IDs collide; their canonical session owns a separate namespace.
    const subject =
      isolationSubject.kind === "profile"
        ? `principal:${hashTextSha256(isolationSubject.profileId).slice(0, 32)}`
        : `required-session:${hashTextSha256(isolationSubject.sessionKey).slice(0, 32)}`;
    return `agent:${resolvedAgentId}:${subject}${workspaceSuffix}`;
  }
  if (scope === "session") {
    return `${trimmed}${workspaceSuffix}`;
  }
  const resolvedAgentId = agentId
    ? normalizeAgentId(agentId)
    : resolveAgentIdFromSessionKey(trimmed);
  return `agent:${resolvedAgentId}${workspaceSuffix}`;
}

/** Extracts the agent id represented by a sandbox scope key, when one exists. */
export function resolveSandboxAgentId(scopeKey: string): string | undefined {
  const trimmed = scopeKey.trim();
  if (!trimmed || trimmed === "shared") {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  if (parts[0] === "agent" && parts[1]) {
    return normalizeAgentId(parts[1]);
  }
  return resolveAgentIdFromSessionKey(trimmed);
}

/** Resolves the host-side workspace paths shared by diagnostics and runtime setup. */
export function resolveSandboxWorkspaceLayoutPaths(params: {
  cfg: Pick<SandboxConfig, "scope" | "workspaceAccess" | "workspaceRoot">;
  rawSessionKey: string;
  agentId?: string;
  isolationSubject?: SandboxIsolationSubject;
  workspaceDir?: string;
}) {
  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(params.cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(
    params.cfg.scope,
    params.rawSessionKey,
    agentWorkspaceDir,
    params.agentId,
    params.isolationSubject,
  );
  const sandboxWorkspaceDir =
    params.cfg.scope === "shared" && !params.isolationSubject
      ? workspaceRoot
      : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir =
    params.cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
  const materializedSkillsRoot = resolveSandboxWorkspaceDir(
    path.join(SANDBOX_STATE_DIR, "skills-workspaces"),
    scopeKey,
  );
  const skillsWorkspaceDir =
    params.cfg.workspaceAccess === "rw"
      ? resolveMaterializedSandboxSkillsWorkspaceDir(materializedSkillsRoot)
      : sandboxWorkspaceDir;

  return {
    agentWorkspaceDir,
    scopeKey,
    sandboxWorkspaceDir,
    skillsWorkspaceDir,
    workspaceDir,
    workspaceSource: params.cfg.workspaceAccess === "rw" ? "agent" : "sandbox",
  } as const;
}
