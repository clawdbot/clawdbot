import fs from "node:fs";
import path from "node:path";

import type { MoltbotConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import { loadAgentIdentityFromWorkspace } from "./identity-file.js";
import { resolveAgentIdentity } from "./identity.js";

export type AgentAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

const ALLOWED_AVATAR_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function normalizeAvatarValue(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveAvatarSource(cfg: MoltbotConfig, agentId: string): string | null {
  const fromConfig = normalizeAvatarValue(resolveAgentIdentity(cfg, agentId)?.avatar);
  if (fromConfig) return fromConfig;
  const workspace = resolveAgentWorkspaceDir(cfg, agentId);
  const fromIdentity = normalizeAvatarValue(loadAgentIdentityFromWorkspace(workspace)?.avatar);
  return fromIdentity;
}

function isRemoteAvatar(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

function isDataAvatar(value: string): boolean {
  return value.toLowerCase().startsWith("data:");
}

function resolveExistingPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative) return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveLocalAvatarPath(params: {
  raw: string;
  workspaceDir: string;
}): { ok: true; filePath: string } | { ok: false; reason: string } {
  const workspaceRoot = resolveExistingPath(params.workspaceDir);
  const raw = params.raw;
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw)
      ? resolveUserPath(raw)
      : path.resolve(workspaceRoot, raw);
  const realPath = resolveExistingPath(resolved);
  if (!isPathWithin(workspaceRoot, realPath)) {
    return { ok: false, reason: "outside_workspace" };
  }
  const ext = path.extname(realPath).toLowerCase();
  if (!ALLOWED_AVATAR_EXTS.has(ext)) {
    return { ok: false, reason: "unsupported_extension" };
  }
  try {
    if (!fs.statSync(realPath).isFile()) {
      return { ok: false, reason: "missing" };
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, filePath: realPath };
}

export function resolveAgentAvatar(cfg: MoltbotConfig, agentId: string): AgentAvatarResolution {
  const source = resolveAvatarSource(cfg, agentId);
  if (!source) {
    return { kind: "none", reason: "missing" };
  }
  if (isRemoteAvatar(source)) {
    return { kind: "remote", url: source };
  }
  if (isDataAvatar(source)) {
    return { kind: "data", url: source };
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const resolved = resolveLocalAvatarPath({ raw: source, workspaceDir });
  if (!resolved.ok) {
    return { kind: "none", reason: resolved.reason };
  }
  return { kind: "local", filePath: resolved.filePath };
}
