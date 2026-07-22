// Stages inbound media into sandbox workspaces before agent execution.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { assertSandboxPath } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { slugifySessionKey } from "../../agents/sandbox/shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { root as fsRoot, FsSafeError } from "../../infra/fs-safe.js";
import { normalizeScpRemoteHost, normalizeScpRemotePath } from "../../infra/scp-host.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveChannelRemoteInboundAttachmentRoots } from "../../media/channel-inbound-roots.js";
import { projectMediaFacts, resolveMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { resolveInboundMediaReference } from "../../media/media-reference.js";
import { getMediaDir, MEDIA_MAX_BYTES } from "../../media/store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { CONFIG_DIR } from "../../utils.js";
import type { MsgContext, TemplateContext } from "../templating.js";

const STAGED_MEDIA_MAX_BYTES = MEDIA_MAX_BYTES;
const SCP_STDERR_TAIL_CHARS = 16_384;

// Attachment indexes are the staging identity. Callers use this map to detect
// partial failures without matching rewritten strings back to source paths.
export type StageSandboxMediaResult = {
  staged: ReadonlyMap<number, string>;
};

const EMPTY_STAGE_RESULT: StageSandboxMediaResult = { staged: new Map() };

type StageableMediaSource = {
  pathForFileName: string;
  physicalPath: string;
};

export async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  sessionKey?: string;
  workspaceDir: string;
  remoteMediaMode?: "sandbox-or-cache" | "cache";
}): Promise<StageSandboxMediaResult> {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir } = params;
  const media = resolveMediaFacts(ctx);
  const pathEntries = media.flatMap((fact, index) => {
    const mediaPath = normalizeOptionalString(fact.path);
    return mediaPath ? [{ index, path: mediaPath }] : [];
  });
  if (pathEntries.length === 0 || !sessionKey) {
    return EMPTY_STAGE_RESULT;
  }

  const forceRemoteCache = ctx.MediaRemoteHost && params.remoteMediaMode === "cache";
  const sandbox = forceRemoteCache
    ? null
    : await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey,
        workspaceDir,
      });

  // For remote attachments without sandbox, use ~/.openclaw/media (not agent workspace for privacy).
  // Managed local inbound refs are already in OpenClaw's media store; when no sandbox is
  // active, copy them into the runner workspace so host-mode shell/doc readers get a path.
  const remoteMediaCacheDir = ctx.MediaRemoteHost
    ? path.join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey))
    : null;
  const effectiveWorkspaceDir = sandbox?.workspaceDir ?? remoteMediaCacheDir ?? workspaceDir;
  if (!effectiveWorkspaceDir) {
    return EMPTY_STAGE_RESULT;
  }

  await fs.mkdir(effectiveWorkspaceDir, { recursive: true });
  const remoteAttachmentRoots = ctx.MediaRemoteHost
    ? (resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx }) ?? [])
    : [];

  const usedNames = new Set<string>();
  const staged = new Map<number, string>();
  const stagedUrlAliases = new Set<number>();
  const hostWorkspaceStagingDir =
    !sandbox && !ctx.MediaRemoteHost
      ? path.join("media", "inbound", `openclaw-staged-${crypto.randomUUID()}`)
      : undefined;

  for (const entry of pathEntries) {
    const source = await resolveStageableMediaSource(entry.path);
    if (!source) {
      continue;
    }
    const allowed = await isAllowedSourcePath({
      source: source.physicalPath,
      mediaRemoteHost: ctx.MediaRemoteHost,
      remoteAttachmentRoots,
    });
    if (!allowed) {
      continue;
    }
    const fileName = allocateStagedFileName(source.pathForFileName, usedNames);
    if (!fileName) {
      continue;
    }
    const stageIntoSandboxMediaDir = Boolean(sandbox);
    const relativeDest =
      stageIntoSandboxMediaDir || hostWorkspaceStagingDir
        ? path.join(hostWorkspaceStagingDir ?? path.join("media", "inbound"), fileName)
        : fileName;
    const dest = path.join(effectiveWorkspaceDir, relativeDest);

    try {
      if (ctx.MediaRemoteHost) {
        await stageRemoteFileIntoRoot({
          remoteHost: ctx.MediaRemoteHost,
          remotePath: source.physicalPath,
          rootDir: effectiveWorkspaceDir,
          relativeDestPath: relativeDest,
          maxBytes: STAGED_MEDIA_MAX_BYTES,
        });
      } else {
        const copySource = await fs.realpath(source.physicalPath).catch(() => source.physicalPath);
        await stageLocalFileIntoRoot({
          sourcePath: copySource,
          rootDir: effectiveWorkspaceDir,
          relativeDestPath: relativeDest,
          maxBytes: STAGED_MEDIA_MAX_BYTES,
        });
      }
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "too-large") {
        logVerbose(
          `Blocking inbound media staging above ${STAGED_MEDIA_MAX_BYTES} bytes: ${source.physicalPath}`,
        );
      } else {
        logVerbose(`Failed to stage inbound media path ${source.physicalPath}: ${String(err)}`);
      }
      continue;
    }

    // For sandbox use relative path, for remote cache use absolute path
    const stagedPath = stageIntoSandboxMediaDir ? toPosixRelativePath(relativeDest) : dest;
    staged.set(entry.index, stagedPath);
    if (
      await isUrlAliasForStagedSource({
        url: media[entry.index]?.url,
        sourcePath: entry.path,
        source,
        mediaRemoteHost: ctx.MediaRemoteHost,
      })
    ) {
      stagedUrlAliases.add(entry.index);
    }
  }

  if (staged.size === 0) {
    return { staged };
  }

  const nextMedia = [...media];
  for (const [index, stagedPath] of staged) {
    const fact = nextMedia[index];
    if (fact) {
      nextMedia[index] = {
        ...fact,
        path: stagedPath,
        ...(stagedUrlAliases.has(index) ? { url: stagedPath } : {}),
        workspaceDir: effectiveWorkspaceDir,
      };
    }
  }
  const legacyWorkspaceDir =
    hostWorkspaceStagingDir && staged.size === pathEntries.length
      ? path.join(effectiveWorkspaceDir, hostWorkspaceStagingDir)
      : undefined;
  applyStagedMediaContext(ctx, nextMedia, legacyWorkspaceDir);
  if (sessionCtx !== ctx) {
    applyStagedMediaContext(sessionCtx, nextMedia, undefined);
  }

  return { staged };
}

async function isUrlAliasForStagedSource(params: {
  url?: string;
  sourcePath: string;
  source: StageableMediaSource;
  mediaRemoteHost?: string;
}): Promise<boolean> {
  const url = normalizeOptionalString(params.url);
  if (!url) {
    return false;
  }
  if (url === params.sourcePath) {
    return true;
  }
  const sourceAbsolutePath = resolveAbsolutePath(params.sourcePath);
  const urlAbsolutePath = resolveAbsolutePath(url);
  if (
    sourceAbsolutePath &&
    urlAbsolutePath &&
    path.normalize(sourceAbsolutePath) === path.normalize(urlAbsolutePath)
  ) {
    return true;
  }
  // Non-identical remote references belong to the remote host; resolving them
  // against local storage could rewrite an unrelated local file by accident.
  if (params.mediaRemoteHost) {
    return false;
  }
  const urlSource = await resolveStageableMediaSource(url);
  if (!urlSource) {
    return false;
  }
  const [sourceIdentity, urlIdentity] = await Promise.all([
    resolveLocalSourceIdentity(params.source.physicalPath),
    resolveLocalSourceIdentity(urlSource.physicalPath),
  ]);
  return sourceIdentity === urlIdentity;
}

async function resolveLocalSourceIdentity(sourcePath: string): Promise<string> {
  return await fs.realpath(sourcePath).catch(() => path.resolve(sourcePath));
}

function applyStagedMediaContext(
  ctx: MsgContext,
  media: MediaFact[],
  legacyWorkspaceDir: string | undefined,
): void {
  ctx.media = media;
  Object.assign(ctx, projectMediaFacts(media));
  if (legacyWorkspaceDir) {
    ctx.MediaWorkspaceDir = legacyWorkspaceDir;
  } else {
    delete ctx.MediaWorkspaceDir;
  }
}

function toPosixRelativePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function resolveStageableMediaSource(value: string): Promise<StageableMediaSource | null> {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const inboundReference = await resolveInboundMediaReference(raw).catch(() => null);
  if (inboundReference) {
    return {
      pathForFileName: inboundReference.physicalPath,
      physicalPath: inboundReference.physicalPath,
    };
  }
  const source = resolveAbsolutePath(raw);
  return source
    ? {
        pathForFileName: source,
        physicalPath: source,
      }
    : null;
}

async function stageLocalFileIntoRoot(params: {
  sourcePath: string;
  rootDir: string;
  relativeDestPath: string;
  maxBytes?: number;
}): Promise<void> {
  const root = await fsRoot(params.rootDir);
  await root.copyIn(params.relativeDestPath, params.sourcePath, {
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
  const inboundReference = await resolveInboundMediaReference(params.source).catch(() => null);
  if (inboundReference) {
    return true;
  }
  const mediaDir = getMediaDir();
  const canonicalMediaDir = await fs.realpath(mediaDir).catch(() => mediaDir);
  if (
    !isInboundPathAllowed({
      filePath: params.source,
      roots: [mediaDir, canonicalMediaDir],
    })
  ) {
    logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
    return false;
  }
  try {
    const canonicalSource = await fs.realpath(params.source).catch(() => params.source);
    await assertSandboxPath({
      filePath: canonicalSource,
      cwd: canonicalMediaDir,
      root: canonicalMediaDir,
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

async function scpFile(remoteHost: string, remotePath: string, localPath: string): Promise<void> {
  const safeRemoteHost = normalizeScpRemoteHost(remoteHost);
  if (!safeRemoteHost) {
    throw new Error("invalid remote host for SCP");
  }
  const safeRemotePath = normalizeScpRemotePath(remotePath);
  if (!safeRemotePath) {
    throw new Error("invalid remote path for SCP");
  }
  const result = await runCommandWithTimeout(
    [
      "scp",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "--",
      `${safeRemoteHost}:${safeRemotePath}`,
      localPath,
    ],
    {
      // Four UTF-8 bytes per code point preserves enough data for the existing
      // UTF-16 diagnostic tail contract without retaining unbounded stderr.
      maxOutputBytes: { stdout: 1, stderr: SCP_STDERR_TAIL_CHARS * 4 },
    },
  );
  if (result.code !== 0) {
    const stderr = appendScpStderrTail("", result.stderr).trim();
    throw new Error(`scp failed (${result.code}): ${stderr}`);
  }
}

function appendScpStderrTail(
  current: string,
  chunk: string,
  maxChars = SCP_STDERR_TAIL_CHARS,
): string {
  const combined = `${current}${chunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return sliceUtf16Safe(combined, Math.max(0, combined.length - maxChars));
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.stageSandboxMediaTestApi")] = {
    scpFile,
  };
}
