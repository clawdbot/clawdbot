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
import { hashTextSha256 } from "./hash.js";

/** Converts an arbitrary session key into a bounded filesystem/container-safe slug. */
export function slugifySessionKey(value: string) {
  const trimmed = value.trim() || "session";
  const hash = hashTextSha256(trimmed).slice(0, 8);
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = safe.slice(0, 32) || "session";
  return `${base}-${hash}`;
}

/** Resolves the per-session sandbox workspace directory under the configured sandbox root. */
export function resolveSandboxWorkspaceDir(root: string, sessionKey: string) {
  const resolvedRoot = resolveUserPath(root);
  const slug = slugifySessionKey(sessionKey);
  return path.join(resolvedRoot, slug);
}

/** Resolves the registry scope key for session-, agent-, or shared-scope sandbox lifetimes. */
export function resolveSandboxScopeKey(scope: "session" | "agent" | "shared", sessionKey: string) {
  const trimmed = sessionKey.trim() || "main";
  if (scope === "shared") {
    return "shared";
  }
  if (scope === "session") {
    return trimmed;
  }
  const agentId = resolveAgentIdFromSessionKey(trimmed);
  return `agent:${agentId}`;
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
