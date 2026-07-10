// Internal local-avatar resolution and pinned file reads.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { readFileDescriptorBoundedSync } from "../infra/file-descriptor-read.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import {
  AVATAR_MAX_BYTES,
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isSupportedLocalAvatarExtension,
  isWindowsAbsolutePath,
  resolveAvatarMime,
} from "../shared/avatar-policy.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

export type LocalAgentAvatarFailureReason =
  | "missing"
  | "outside_workspace"
  | "too_large"
  | "unreadable"
  | "unsupported_extension";

export type OpenedLocalAgentAvatarFile = {
  path: string;
  fd: number;
};

type LocalAgentAvatarPath = {
  filePath: string;
  workspaceRoot: string;
};

function resolveExistingPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/** Resolve one local avatar source while retaining its canonical workspace root. */
export function resolveLocalAgentAvatarPath(params: {
  raw: string;
  workspaceDir: string;
}):
  | { ok: true; value: LocalAgentAvatarPath }
  | { ok: false; reason: LocalAgentAvatarFailureReason } {
  const workspaceRoot = resolveExistingPath(params.workspaceDir);
  const resolved =
    params.raw.startsWith("~") || path.isAbsolute(params.raw)
      ? resolveUserPath(params.raw)
      : path.resolve(workspaceRoot, params.raw);
  const filePath = resolveExistingPath(resolved);
  if (!isPathWithinRoot(workspaceRoot, filePath)) {
    return { ok: false, reason: "outside_workspace" };
  }
  if (!isSupportedLocalAvatarExtension(filePath)) {
    return { ok: false, reason: "unsupported_extension" };
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: "missing" };
    }
    if (stat.size > AVATAR_MAX_BYTES) {
      return { ok: false, reason: "too_large" };
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, value: { filePath, workspaceRoot } };
}

function openResolvedLocalAgentAvatarFile(
  resolved: LocalAgentAvatarPath,
): OpenedLocalAgentAvatarFile | null {
  try {
    const opened = openRootFileSync({
      absolutePath: resolved.filePath,
      rootPath: resolved.workspaceRoot,
      rootRealPath: resolved.workspaceRoot,
      boundaryLabel: "agent workspace",
      maxBytes: AVATAR_MAX_BYTES,
      rejectHardlinks: true,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      return null;
    }
    if (!isSupportedLocalAvatarExtension(opened.path)) {
      fs.closeSync(opened.fd);
      return null;
    }
    return { path: opened.path, fd: opened.fd };
  } catch {
    return null;
  }
}

/**
 * Open one selected local avatar under its agent workspace.
 * A successful caller owns `file.fd` and must close it exactly once.
 */
export function openLocalAgentAvatarFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  source: string;
}):
  | { ok: true; file: OpenedLocalAgentAvatarFile }
  | { ok: false; reason: LocalAgentAvatarFailureReason } {
  const resolved = resolveLocalAgentAvatarPath({
    raw: params.source,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
  });
  if (!resolved.ok) {
    return resolved;
  }
  const file = openResolvedLocalAgentAvatarFile(resolved.value);
  return file ? { ok: true, file } : { ok: false, reason: "unreadable" };
}

/** Consume a pinned local avatar descriptor into a data URL. Always closes it. */
export function readOpenedLocalAgentAvatarDataUrl(
  opened: OpenedLocalAgentAvatarFile,
): string | undefined {
  try {
    // Keep the validated inode pinned through the read. Reopening by path
    // would restore the symlink/rename race that openRootFileSync closes.
    const buffer = readFileDescriptorBoundedSync(opened.fd, AVATAR_MAX_BYTES);
    return `data:${resolveAvatarMime(opened.path)};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Resolve one configured avatar source for agent-list projections. */
export function resolveAgentAvatarUrlFromSource(
  cfg: OpenClawConfig,
  agentId: string,
  source: string | null | undefined,
): string | undefined {
  const normalized = normalizeOptionalString(source);
  if (!normalized) {
    return undefined;
  }
  if (isAvatarHttpUrl(normalized) || isRenderableAvatarImageDataUrl(normalized)) {
    return normalized;
  }
  if (
    isAvatarDataUrl(normalized) ||
    (hasAvatarUriScheme(normalized) && !isWindowsAbsolutePath(normalized))
  ) {
    return undefined;
  }
  const opened = openLocalAgentAvatarFile({ cfg, agentId, source: normalized });
  return opened.ok ? readOpenedLocalAgentAvatarDataUrl(opened.file) : undefined;
}
