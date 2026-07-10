/**
 * Projects resolved agent avatars into browser-safe URLs for internal Gateway/UI payloads.
 */
import fs from "node:fs";
import type { AgentAvatarResolution } from "./identity-avatar.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";

function readLocalAvatarDataUrl(
  resolved: Extract<AgentAvatarResolution, { kind: "local" }>,
): string | undefined {
  try {
    // Keep validation and reading on the same opened descriptor. Reopening the
    // pathname here would let a symlink swap escape the workspace boundary.
    const opened = openRootFileSync({
      absolutePath: resolved.filePath,
      rootPath: resolved.workspaceRoot,
      rootRealPath: resolved.workspaceRoot,
      boundaryLabel: "workspace root",
      maxBytes: AVATAR_MAX_BYTES,
      rejectHardlinks: true,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      return undefined;
    }
    try {
      const buffer = fs.readFileSync(opened.fd);
      const mime = resolveAvatarMime(opened.path);
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch {
    return undefined;
  }
}

/** Project a verified avatar to the browser-safe value shared by Gateway identity surfaces. */
export function resolveAgentAvatarUrl(resolved: AgentAvatarResolution): string | undefined {
  if (resolved.kind === "remote" || resolved.kind === "data") {
    return resolved.url;
  }
  return resolved.kind === "local" ? readLocalAvatarDataUrl(resolved) : undefined;
}
