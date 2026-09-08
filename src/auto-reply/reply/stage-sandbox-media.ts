// Stages inbound media into sandbox workspaces before agent execution.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { assertSandboxPath } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { slugifySessionKey } from "../../agents/sandbox/shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { root as fsRoot, FsSafeError, readLocalFileSafely } from "../../infra/fs-safe.js";
import { safeFileURLToPath } from "../../infra/local-file-access.js";
import { retryAsync } from "../../infra/retry.js";
import { normalizeScpRemoteHost, normalizeScpRemotePath } from "../../infra/scp-host.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveChannelRemoteInboundAttachmentRoots } from "../../media/channel-inbound-roots.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import { resolveInboundMediaReference } from "../../media/media-reference.js";
import {
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { getMediaDir } from "../../media/store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { CONFIG_DIR } from "../../utils.js";
import type { RuntimeMsgContext as MsgContext, TemplateContext } from "../templating.js";

/** Maximum size of one file copied into an agent sandbox or staging workspace. */
export const SANDBOX_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const SCP_STDERR_TAIL_CHARS = 16_384;

// Attachment indexes are the staging identity. Callers use this map to detect
// partial failures without matching rewritten strings back to source paths.
export type StageSandboxMediaResult = {
  staged: ReadonlyMap<number, string>;
};

const EMPTY_STAGE_RESULT: StageSandboxMediaResult = { staged: new Map() };

export async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir: string;
  remoteMediaMode?: "sandbox-or-cache" | "cache";
  abortSignal?: AbortSignal;
}): Promise<StageSandboxMediaResult> {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir, abortSignal } = params;
  abortSignal?.throwIfAborted();
  const media = normalizeMediaFacts(ctx.media);
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
        agentId: params.agentId,
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
  const inputDirectory = stagedInputDirectory(crypto.randomUUID());
  let stagingReady = false;
  const prepareDestination = async () => {
    if (!stagingReady) {
      // Keep the privacy marker ahead of file publication, after source validation.
      await ensureStagedInputDirectory(effectiveWorkspaceDir, inputDirectory, abortSignal);
      stagingReady = true;
    }
  };

  for (const entry of pathEntries) {
    abortSignal?.throwIfAborted();
    const source = await resolveStageableMediaSource(entry.path);
    if (!source) {
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
    // Keep published relative paths portable; resolve the native destination below.
    const relativeDest = path.posix.join(inputDirectory, fileName);
    const dest = path.join(effectiveWorkspaceDir, relativeDest);

    try {
      if (ctx.MediaRemoteHost) {
        await stageRemoteFileIntoRoot({
          remoteHost: ctx.MediaRemoteHost,
          remotePath: source,
          rootDir: effectiveWorkspaceDir,
          relativeDestPath: relativeDest,
          abortSignal,
          prepareDestination,
        });
      } else {
        const copySource = await fs.realpath(source).catch(() => source);
        await stageLocalFileIntoRoot({
          sourcePath: copySource,
          rootDir: effectiveWorkspaceDir,
          relativeDestPath: relativeDest,
          abortSignal,
          prepareDestination,
        });
      }
    } catch (err) {
      if (abortSignal?.aborted && Object.is(err, abortSignal.reason)) {
        throw err;
      }
      if (err instanceof FsSafeError && err.code === "too-large") {
        console.warn(`Inbound media staging skipped for ${fileName}: ${err.message}`);
      } else {
        logVerbose(`Failed to stage inbound media path ${source}: ${String(err)}`);
      }
      continue;
    }

    // For sandbox use relative path, for remote cache use absolute path
    const stagedPath = sandbox ? relativeDest : dest;
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

  // Path checks and alias resolution can finish after cancellation. Fence even
  // an empty result so callers cannot start the next preprocessing phase.
  abortSignal?.throwIfAborted();
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
        staged: true,
      };
    }
  }
  ctx.media = nextMedia;
  if (sessionCtx !== ctx) {
    sessionCtx.media = nextMedia;
  }

  return { staged };
}

async function isUrlAliasForStagedSource(params: {
  url?: string;
  sourcePath: string;
  source: string;
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
    resolveLocalSourceIdentity(params.source),
    resolveLocalSourceIdentity(urlSource),
  ]);
  return sourceIdentity === urlIdentity;
}

async function resolveLocalSourceIdentity(sourcePath: string): Promise<string> {
  return await fs.realpath(sourcePath).catch(() => path.resolve(sourcePath));
}

async function resolveStageableMediaSource(value: string): Promise<string | null> {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const inboundReference = await resolveInboundMediaReference(raw).catch(() => null);
  return inboundReference?.physicalPath ?? resolveAbsolutePath(raw);
}

async function stageLocalFileIntoRoot(params: {
  sourcePath: string;
  rootDir: string;
  relativeDestPath: string;
  abortSignal?: AbortSignal;
  prepareDestination: () => Promise<void>;
}): Promise<void> {
  const root = await fsRoot(params.rootDir);
  const source = await readLocalFileSafely({
    filePath: params.sourcePath,
    maxBytes: SANDBOX_MEDIA_MAX_BYTES,
  });
  // A completed read must not start a new copy after cancellation.
  params.abortSignal?.throwIfAborted();
  await params.prepareDestination();
  params.abortSignal?.throwIfAborted();
  await root.create(params.relativeDestPath, source.buffer);
}

async function stageRemoteFileIntoRoot(params: {
  remoteHost: string;
  remotePath: string;
  rootDir: string;
  relativeDestPath: string;
  abortSignal?: AbortSignal;
  prepareDestination: () => Promise<void>;
}): Promise<void> {
  const { abortSignal } = params;
  const safeRemoteHost = normalizeScpRemoteHost(params.remoteHost);
  if (!safeRemoteHost) {
    throw new Error("invalid remote host for SCP");
  }
  const safeRemotePath = normalizeScpRemotePath(params.remotePath);
  if (!safeRemotePath) {
    throw new Error("invalid remote path for SCP");
  }
  const tmpRoot = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(tmpRoot, "stage-sandbox-media-"));
  const tmpPath = path.join(tmpDir, "download");
  try {
    await retryAsync(
      async () => {
        if (abortSignal?.aborted) {
          return;
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
            tmpPath,
          ],
          {
            // The runner owns both descendants and settlement before temp cleanup.
            signal: abortSignal,
            killProcessTree: true,
            // Four UTF-8 bytes retain the existing UTF-16 diagnostic tail bound.
            maxOutputBytes: { stdout: 1, stderr: SCP_STDERR_TAIL_CHARS * 4 },
          },
        );
        if (result.code !== 0) {
          // A late abort can coexist with a concrete failed exit; keep that error.
          if (result.code === null && result.termination === "signal" && abortSignal?.aborted) {
            return;
          }
          const stderr = sliceUtf16Safe(result.stderr, -SCP_STDERR_TAIL_CHARS).trim();
          throw new Error(`scp failed (${result.code}): ${stderr}`);
        }
      },
      { attempts: 3, label: "remote inbound media SCP", shouldRetry: () => !abortSignal?.aborted },
    );
    // Preserve arbitrary abort reasons outside retry's Error normalization.
    abortSignal?.throwIfAborted();
    await stageLocalFileIntoRoot({
      ...params,
      sourcePath: tmpPath,
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
  if (/^file:/iu.test(resolved)) {
    try {
      resolved = safeFileURLToPath(resolved);
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

function allocateStagedFileName(source: string, usedNames: Set<string>): string {
  const baseName = stagedInputFileName(path.basename(source));
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
