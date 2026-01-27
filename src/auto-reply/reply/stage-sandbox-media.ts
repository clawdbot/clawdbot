import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { MoltbotConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { CONFIG_DIR } from "../../utils.js";
import type { MsgContext, TemplateContext } from "../templating.js";

export async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: MoltbotConfig;
  sessionKey?: string;
  workspaceDir: string;
}) {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir } = params;
  const hasPathsArray = Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0;
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const rawPaths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (rawPaths.length === 0 || !sessionKey) return;

  const sandbox = await ensureSandboxWorkspaceForSession({
    config: cfg,
    sessionKey,
    workspaceDir,
  });

  // For remote attachments without sandbox, use ~/.clawdbot/media (not agent workspace for privacy)
  const remoteMediaCacheDir = ctx.MediaRemoteHost
    ? path.join(CONFIG_DIR, "media", "remote-cache", sessionKey)
    : null;
  const effectiveWorkspaceDir = sandbox?.workspaceDir ?? remoteMediaCacheDir;
  if (!effectiveWorkspaceDir) return;

  const resolveAbsolutePath = (value: string): string | null => {
    let resolved = value.trim();
    if (!resolved) return null;
    if (resolved.startsWith("file://")) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        return null;
      }
    }
    if (!path.isAbsolute(resolved)) return null;
    return resolved;
  };

  try {
    // For sandbox: <workspace>/media/inbound, for remote cache: use dir directly
    const destDir = sandbox
      ? path.join(effectiveWorkspaceDir, "media", "inbound")
      : effectiveWorkspaceDir;
    await fs.mkdir(destDir, { recursive: true });

    const usedNames = new Set<string>();
    const staged = new Map<string, string>(); // absolute source -> relative sandbox path

    for (const raw of rawPaths) {
      const source = resolveAbsolutePath(raw);
      if (!source) continue;
      if (staged.has(source)) continue;

      const baseName = path.basename(source);
      if (!baseName) continue;
      const parsed = path.parse(baseName);
      let fileName = baseName;
      let suffix = 1;
      while (usedNames.has(fileName)) {
        fileName = `${parsed.name}-${suffix}${parsed.ext}`;
        suffix += 1;
      }
      usedNames.add(fileName);

      const dest = path.join(destDir, fileName);
      if (ctx.MediaRemoteHost) {
        // Always use SCP when remote host is configured - local paths refer to remote machine
        await scpFile(ctx.MediaRemoteHost, source, dest);
      } else {
        await fs.copyFile(source, dest);
      }
      // For sandbox use relative path, for remote cache use absolute path
      const stagedPath = sandbox ? path.posix.join("media", "inbound", fileName) : dest;
      staged.set(source, stagedPath);
    }

    const rewriteIfStaged = (value: string | undefined): string | undefined => {
      const raw = value?.trim();
      if (!raw) return value;
      const abs = resolveAbsolutePath(raw);
      if (!abs) return value;
      const mapped = staged.get(abs);
      return mapped ?? value;
    };

    const nextMediaPaths = hasPathsArray ? rawPaths.map((p) => rewriteIfStaged(p) ?? p) : undefined;
    if (nextMediaPaths) {
      ctx.MediaPaths = nextMediaPaths;
      sessionCtx.MediaPaths = nextMediaPaths;
      ctx.MediaPath = nextMediaPaths[0];
      sessionCtx.MediaPath = nextMediaPaths[0];
    } else {
      const rewritten = rewriteIfStaged(ctx.MediaPath);
      if (rewritten && rewritten !== ctx.MediaPath) {
        ctx.MediaPath = rewritten;
        sessionCtx.MediaPath = rewritten;
      }
    }

    if (Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length > 0) {
      const nextUrls = ctx.MediaUrls.map((u) => rewriteIfStaged(u) ?? u);
      ctx.MediaUrls = nextUrls;
      sessionCtx.MediaUrls = nextUrls;
    }
    const rewrittenUrl = rewriteIfStaged(ctx.MediaUrl);
    if (rewrittenUrl && rewrittenUrl !== ctx.MediaUrl) {
      ctx.MediaUrl = rewrittenUrl;
      sessionCtx.MediaUrl = rewrittenUrl;
    }
  } catch (err) {
    logVerbose(`Failed to stage inbound media for sandbox: ${String(err)}`);
  }
}

async function scpFile(remoteHost: string, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/scp",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        `${remoteHost}:${remotePath}`,
        localPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scp failed (${code}): ${stderr.trim()}`));
    });
  });
}
