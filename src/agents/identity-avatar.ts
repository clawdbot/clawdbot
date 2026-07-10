/**
 * Resolves public avatar sources for configured agent identities.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AVATAR_MAX_BYTES,
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isWindowsAbsolutePath,
  isPathWithinRoot,
  isSupportedLocalAvatarExtension,
} from "../shared/avatar-policy.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { loadAgentIdentityFromWorkspace } from "./identity-file.js";
import { resolveAgentIdentity } from "./identity.js";

// Agent avatar resolution for UI/public surfaces. Remote/data sources are
// allowed directly; local files must stay inside the agent workspace and satisfy
// shared avatar policy limits.
export type AgentAvatarResolution =
  | { kind: "none"; reason: string; source?: string }
  | { kind: "local"; filePath: string; workspaceRoot: string; source: string }
  | { kind: "remote"; url: string; source: string }
  | { kind: "data"; url: string; source: string };

type AgentAvatarPublicSourceInput = {
  kind: AgentAvatarResolution["kind"];
  source?: string | null;
};

const PUBLIC_AVATAR_SOURCE_MAX_CHARS = 256;
const PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS = 64;

function resolveEffectiveAvatarSource(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { includeUiOverride?: boolean },
): string | null {
  const normalizedAgentId = normalizeAgentId(agentId);
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const fromUiConfig = normalizeOptionalString(cfg.ui?.assistant?.avatar) ?? null;
  if (opts?.includeUiOverride) {
    // UI override only wins for the default agent unless callers explicitly ask
    // for it as a final fallback for non-default agents.
    if (normalizedAgentId === defaultAgentId && fromUiConfig) {
      return fromUiConfig;
    }
  }
  const fromConfig =
    normalizeOptionalString(resolveAgentIdentity(cfg, normalizedAgentId)?.avatar) ?? null;
  if (fromConfig) {
    return fromConfig;
  }
  const workspace = resolveAgentWorkspaceDir(cfg, normalizedAgentId);
  const fromIdentity =
    normalizeOptionalString(loadAgentIdentityFromWorkspace(workspace)?.avatar) ?? null;
  if (fromIdentity) {
    return fromIdentity;
  }
  return opts?.includeUiOverride ? fromUiConfig : null;
}

function resolveExistingPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveLocalAvatarPath(params: {
  raw: string;
  workspaceDir: string;
}): { ok: true; filePath: string; workspaceRoot: string } | { ok: false; reason: string } {
  const workspaceRoot = resolveExistingPath(params.workspaceDir);
  const raw = params.raw;
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw)
      ? resolveUserPath(raw)
      : path.resolve(workspaceRoot, raw);
  const realPath = resolveExistingPath(resolved);
  // Resolve symlinks before the workspace check so local avatar paths cannot
  // escape the workspace through link traversal.
  if (!isPathWithinRoot(workspaceRoot, realPath)) {
    return { ok: false, reason: "outside_workspace" };
  }
  if (!isSupportedLocalAvatarExtension(realPath)) {
    return { ok: false, reason: "unsupported_extension" };
  }
  try {
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      return { ok: false, reason: "missing" };
    }
    if (stat.size > AVATAR_MAX_BYTES) {
      return { ok: false, reason: "too_large" };
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, filePath: realPath, workspaceRoot };
}

/** Resolve one configured source without applying UI or IDENTITY.md fallback precedence. */
export function resolveAgentAvatarFromSource(
  cfg: OpenClawConfig,
  agentId: string,
  source: string | null | undefined,
): AgentAvatarResolution {
  const normalized = normalizeOptionalString(source) ?? null;
  if (!normalized) {
    return { kind: "none", reason: "missing" };
  }
  if (isAvatarHttpUrl(normalized)) {
    return { kind: "remote", url: normalized, source: normalized };
  }
  if (isAvatarDataUrl(normalized)) {
    return { kind: "data", url: normalized, source: normalized };
  }
  const resolved = resolveLocalAvatarPath({
    raw: normalized,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  });
  if (!resolved.ok) {
    return { kind: "none", reason: resolved.reason, source: normalized };
  }
  return {
    kind: "local",
    filePath: resolved.filePath,
    workspaceRoot: resolved.workspaceRoot,
    source: normalized,
  };
}

function isSafeRelativeAvatarSource(source: string): boolean {
  if (
    source.length > PUBLIC_AVATAR_SOURCE_MAX_CHARS ||
    source.startsWith("~") ||
    path.isAbsolute(source) ||
    isWindowsAbsolutePath(source) ||
    (hasAvatarUriScheme(source) && !isWindowsAbsolutePath(source)) ||
    source.includes("\0")
  ) {
    return false;
  }
  const parts = source.replace(/\\/g, "/").split("/");
  return parts.every((part) => part !== "..");
}

/** Return a safe public description of the configured avatar source. */
export function resolvePublicAgentAvatarSource(
  resolved: AgentAvatarPublicSourceInput,
): string | undefined {
  const source = normalizeOptionalString(resolved.source) ?? null;
  if (!source) {
    return undefined;
  }
  if (isAvatarDataUrl(source)) {
    // Data URLs can be large and sensitive; expose only the media/header prefix.
    const commaIndex = source.indexOf(",");
    const header =
      commaIndex > 0
        ? source.slice(0, Math.min(commaIndex, PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS))
        : source.slice(0, PUBLIC_DATA_AVATAR_HEADER_MAX_CHARS);
    return `${header},...`;
  }
  if (isAvatarHttpUrl(source)) {
    return "remote URL";
  }
  return isSafeRelativeAvatarSource(source) ? source : undefined;
}

/** Resolve the effective avatar for an agent, including config and IDENTITY.md. */
export function resolveAgentAvatar(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { includeUiOverride?: boolean },
): AgentAvatarResolution {
  return resolveAgentAvatarFromSource(
    cfg,
    agentId,
    resolveEffectiveAvatarSource(cfg, agentId, opts),
  );
}
