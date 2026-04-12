import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSandboxPath } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { copyFileWithinRoot, SafeOpenError } from "../../infra/fs-safe.js";
import { normalizeScpRemoteHost, normalizeScpRemotePath } from "../../infra/scp-host.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveChannelRemoteInboundAttachmentRoots } from "../../media/channel-inbound-roots.js";
import { isInboundPathAllowed } from "../../media/inbound-path-policy.js";
import { getMediaDir, MEDIA_MAX_BYTES } from "../../media/store.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CONFIG_DIR } from "../../utils.js";
import type { MsgContext, TemplateContext } from "../templating.js";

const STAGED_MEDIA_MAX_BYTES = MEDIA_MAX_BYTES;

export async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  sessionKey?: string;
  workspaceDir: string;
}) {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir } = params;
  const hasPathsArray = Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0;
  const rawPaths = resolveRawPaths(ctx);
  if (rawPaths.length === 0 || !sessionKey) {
    return;
  }

  const sandbox = await ensureSandboxWorkspaceForSession({
    config: cfg,
    sessionKey,
    workspaceDir,
  });

  // For remote attachments without sandbox, use ~/.openclaw/media (not agent workspace for privacy)
  const remoteMediaCacheDir = ctx.MediaRemoteHost
    ? path.join(CONFIG_DIR, "media", "remote-cache", sessionKey)
    : null;
  const effectiveWorkspaceDir = sandbox?.workspaceDir ?? remoteMediaCacheDir;
  if (!effectiveWorkspaceDir) {
    return;
  }

  await fs.mkdir(effectiveWorkspaceDir, { recursive: true });
  const remoteAttachmentRoots = resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx }) ?? [];

  const usedNames = new Set<string>();
  const staged = new Map<string, string>(); // absolute source -> relative sandbox path

  for (const raw of rawPaths) {
    const source = resolveAbsolutePath(raw);
    if (!source || staged.has(source)) {
      continue;
    }
    const allowed = await isAllowedSourcePath({
      source,
      mediaRemoteHost: ctx.MediaRemoteHost,
      remoteAttachmentRoots,
    });
    if (!allowed) {
      continue;
    }
    const fileName = allocateStagedFileName(source, usedNames);
    if (!fileName) {
      continue;
    }
    const relativeDest = sandbox ? path.join("media", "inbound", fileName) : fileName;
    const dest = path.join(effectiveWorkspaceDir, relativeDest);

    try {
      if (ctx.MediaRemoteHost) {
        await stageRemoteFileIntoRoot({
          remoteHost: ctx.MediaRemoteHost,
          remotePath: source,
          rootDir: effectiveWorkspaceDir,
          relativeDestPath: relativeDest,
          maxBytes: STAGED_MEDIA_MAX_BYTES,
        });
      } else {
        await stageLocalFileIntoRoot({
          sourcePath: source,
          rootDir: effectiveWorkspaceDir,
          relativeDestPath: relativeDest,
          maxBytes: STAGED_MEDIA_MAX_BYTES,
        });
      }
    } catch (err) {
      if (err instanceof SafeOpenError && err.code === "too-large") {
        logVerbose(
          `Blocking inbound media staging above ${STAGED_MEDIA_MAX_BYTES} bytes: ${source}`,
        );
      } else {
        logVerbose(`Failed to stage inbound media path ${source}: ${String(err)}`);
      }
      continue;
    }

    // For sandbox use relative path, for remote cache use absolute path
    const stagedPath = sandbox ? path.posix.join("media", "inbound", fileName) : dest;
    staged.set(source, stagedPath);
  }

  rewriteStagedMediaPaths({
    ctx,
    sessionCtx,
    rawPaths,
    staged,
    hasPathsArray,
  });
}

async function stageLocalFileIntoRoot(params: {
  sourcePath: string;
  rootDir: string;
  relativeDestPath: string;
  maxBytes?: number;
}): Promise<void> {
  await copyFileWithinRoot({
    sourcePath: params.sourcePath,
    rootDir: params.rootDir,
    relativePath: params.relativeDestPath,
    maxBytes: params.maxBytes,
  });
}

async function stageRemoteFileIntoRoot(params: {
  remoteHost: string;
  remotePath: string;
  rootDir: string;
  relativeDestPath: string;
  maxBytes?: number;
}): Promise<void> {
  const tmpRoot = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(tmpRoot, "stage-sandbox-media-"));
  const tmpPath = path.join(tmpDir, "download");
  try {
    await scpFile(params.remoteHost, params.remotePath, tmpPath);
    await stageLocalFileIntoRoot({
      sourcePath: tmpPath,
      rootDir: params.rootDir,
      relativeDestPath: params.relativeDestPath,
      maxBytes: params.maxBytes,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveRawPaths(ctx: MsgContext): string[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  return pathsFromArray && pathsFromArray.length > 0
    ? pathsFromArray
    : normalizeOptionalString(ctx.MediaPath)
      ? [normalizeOptionalString(ctx.MediaPath)!]
      : [];
}

function resolveAbsolutePath(value: string): string | null {
  let resolved = value.trim();
  if (!resolved) {
    return null;
  }
  if (resolved.startsWith("file://")) {
    try {
      resolved = fileURLToPath(resolved);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(resolved)) {
    return null;
  }
  return resolved;
}

async function isAllowedSourcePath(params: {
  source: string;
  mediaRemoteHost?: string;
  remoteAttachmentRoots: readonly string[];
}): Promise<boolean> {
  if (params.mediaRemoteHost) {
    if (
      !isInboundPathAllowed({
        filePath: params.source,
        roots: params.remoteAttachmentRoots,
      })
    ) {
      logVerbose(`Blocking remote media staging from disallowed attachment path: ${params.source}`);
      return false;
    }
    return true;
  }
  const mediaDir = getMediaDir();
  if (
    !isInboundPathAllowed({
      filePath: params.source,
      roots: [mediaDir],
    })
  ) {
    logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
    return false;
  }
  try {
    await assertSandboxPath({
      filePath: params.source,
      cwd: mediaDir,
      root: mediaDir,
    });
    return true;
  } catch {
    logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
    return false;
  }
}

function allocateStagedFileName(source: string, usedNames: Set<string>): string | null {
  const baseName = path.basename(source);
  if (!baseName) {
    return null;
  }
  const parsed = path.parse(baseName);
  let fileName = baseName;
  let suffix = 1;
  while (usedNames.has(fileName)) {
    fileName = `${parsed.name}-${suffix}${parsed.ext}`;
    suffix += 1;
  }
  usedNames.add(fileName);
  return fileName;
}

function rewriteStagedMediaPaths(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  rawPaths: string[];
  staged: Map<string, string>;
  hasPathsArray: boolean;
}): void {
  const rewriteIfStaged = (value: string | undefined): string | undefined => {
    const raw = normalizeOptionalString(value);
    if (!raw) {
      return value;
    }
    const abs = resolveAbsolutePath(raw);
    if (!abs) {
      return value;
    }
    const mapped = params.staged.get(abs);
    return mapped ?? value;
  };

  const nextMediaPaths = params.hasPathsArray
    ? params.rawPaths.map((p) => rewriteIfStaged(p) ?? p)
    : undefined;
  if (nextMediaPaths) {
    params.ctx.MediaPaths = nextMediaPaths;
    params.sessionCtx.MediaPaths = nextMediaPaths;
    params.ctx.MediaPath = nextMediaPaths[0];
    params.sessionCtx.MediaPath = nextMediaPaths[0];
  } else {
    const rewritten = rewriteIfStaged(params.ctx.MediaPath);
    if (rewritten && rewritten !== params.ctx.MediaPath) {
      params.ctx.MediaPath = rewritten;
      params.sessionCtx.MediaPath = rewritten;
    }
  }

  if (Array.isArray(params.ctx.MediaUrls) && params.ctx.MediaUrls.length > 0) {
    const nextUrls = params.ctx.MediaUrls.map((u) => rewriteIfStaged(u) ?? u);
    params.ctx.MediaUrls = nextUrls;
    params.sessionCtx.MediaUrls = nextUrls;
  }
  const rewrittenUrl = rewriteIfStaged(params.ctx.MediaUrl);
  if (rewrittenUrl && rewrittenUrl !== params.ctx.MediaUrl) {
    params.ctx.MediaUrl = rewrittenUrl;
    params.sessionCtx.MediaUrl = rewrittenUrl;
  }
}

async function scpFile(remoteHost: string, remotePath: string, localPath: string): Promise<void> {
  const safeRemoteHost = normalizeScpRemoteHost(remoteHost);
  if (!safeRemoteHost) {
    throw new Error("invalid remote host for SCP");
  }
  const safeRemotePath = normalizeScpRemotePath(remotePath);
  if (!safeRemotePath) {
    throw new Error("invalid remote path for SCP");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/scp",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "--",
        `${safeRemoteHost}:${safeRemotePath}`,
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
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`scp failed (${code}): ${stderr.trim()}`));
      }
    });
  });
}
