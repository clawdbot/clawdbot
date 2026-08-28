// Resolves media paths from reply payloads into runtime attachment metadata.
import path from "node:path";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolvePathFromInput, toRelativeWorkspacePath } from "../../agents/path-policy.js";
import {
  assertMediaNotDataUrl,
  resolveAllowedManagedMediaPath,
  resolveSandboxedMediaSource,
} from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { resolveOutboundAttachmentFromUrl } from "../../media/outbound-attachment.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import {
  appendReplyMediaFailureWarning,
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const FILE_URL_RE = /^file:/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;

function isLikelyLocalMediaSource(media: string): boolean {
  return (
    FILE_URL_RE.test(media) ||
    media.startsWith("/") ||
    media.startsWith("./") ||
    media.startsWith("../") ||
    media.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(media) ||
    media.startsWith("\\\\") ||
    (!SCHEME_RE.test(media) &&
      (media.includes("/") || media.includes("\\") || HAS_FILE_EXT_RE.test(media)))
  );
}

function getPayloadMediaList(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls;
}

export function createReplyMediaPathNormalizer(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  messageProvider?: string;
  accountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
}): (payload: ReplyPayload) => Promise<ReplyPayload> {
  // Prefer an explicit agentId so callers without a resolved sessionKey (e.g.
  // `openclaw agent --deliver` with `--reply-channel/--reply-to`) still get
  // the stricter agent-scoped file-read policy applied during staging.
  const agentId =
    params.agentId ??
    (params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : undefined);
  const maxBytes = resolveOutboundMediaMaxBytes({
    cfg: params.cfg,
    channel: params.messageProvider,
    accountId: params.accountId,
  });
  const explicitSandboxRoot = params.sandboxRoot?.trim();
  let sandboxWorkspacePromise:
    | Promise<{ root: string; containerWorkdir?: string } | undefined>
    | undefined = explicitSandboxRoot
    ? Promise.resolve({
        root: explicitSandboxRoot,
        containerWorkdir: params.sandboxContainerWorkdir,
      })
    : undefined;
  const persistedMediaBySource = new Map<string, Promise<{ path: string; contentType?: string }>>();

  const resolveSandboxWorkspace = async () => {
    if (!sandboxWorkspacePromise) {
      sandboxWorkspacePromise = ensureSandboxWorkspaceForSession({
        config: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      }).then((sandbox) =>
        sandbox
          ? { root: sandbox.workspaceDir, containerWorkdir: sandbox.containerWorkdir }
          : undefined,
      );
    }
    return await sandboxWorkspacePromise;
  };

  const resolveMediaAccessForSource = (media: string) =>
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId,
      workspaceDir: params.workspaceDir,
      mediaSources: [media],
      sessionKey: params.sessionKey,
      messageProvider: params.sessionKey ? undefined : params.messageProvider,
      accountId: params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
    });

  const persistLocalReplyMedia = async (
    media: string,
  ): Promise<{ path: string; contentType?: string }> => {
    if (!isLikelyLocalMediaSource(media)) {
      return { path: media };
    }
    const managedMediaPath = await resolveAllowedManagedMediaPath(media);
    if (managedMediaPath) {
      return {
        path: managedMediaPath,
        contentType: mimeTypeFromFilePath(managedMediaPath),
      };
    }
    const cached = persistedMediaBySource.get(media);
    if (cached) {
      return await cached;
    }
    const persistPromise = resolveOutboundAttachmentFromUrl(media, maxBytes, {
      mediaAccess: resolveMediaAccessForSource(media),
    })
      .then((saved) => ({
        ...saved,
        contentType: saved.contentType ?? mimeTypeFromFilePath(media) ?? "application/octet-stream",
      }))
      .catch((err: unknown) => {
        persistedMediaBySource.delete(media);
        throw err;
      });
    persistedMediaBySource.set(media, persistPromise);
    return await persistPromise;
  };

  const resolveWorkspaceRelativeMedia = (media: string): string => {
    const relativeWorkspacePath = toRelativeWorkspacePath(params.workspaceDir, media, {
      cwd: params.workspaceDir,
    });
    return resolvePathFromInput(relativeWorkspacePath, params.workspaceDir);
  };

  const resolveAbsoluteWorkspaceMedia = (media: string): string | undefined => {
    if (FILE_URL_RE.test(media) || (!path.isAbsolute(media) && !WINDOWS_DRIVE_RE.test(media))) {
      return undefined;
    }
    try {
      return resolveWorkspaceRelativeMedia(media);
    } catch {
      return undefined;
    }
  };

  const normalizeMediaSource = async (
    raw: string,
  ): Promise<{
    mediaUrl: string;
    trustedLocalMedia: boolean;
    fileName?: string;
    mimeType?: string;
  }> => {
    const media = raw.trim();
    if (!media) {
      return { mediaUrl: media, trustedLocalMedia: false };
    }
    assertMediaNotDataUrl(media);
    if (isPassThroughRemoteMediaSource(media)) {
      return { mediaUrl: media, trustedLocalMedia: false };
    }
    const absoluteWorkspaceMedia = resolveAbsoluteWorkspaceMedia(media);
    if (absoluteWorkspaceMedia) {
      const persisted = await persistLocalReplyMedia(absoluteWorkspaceMedia);
      return {
        mediaUrl: persisted.path,
        trustedLocalMedia: true,
        fileName: path.basename(absoluteWorkspaceMedia),
        ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
      };
    }
    const isRelativeLocalMedia =
      isLikelyLocalMediaSource(media) &&
      !FILE_URL_RE.test(media) &&
      !media.startsWith("~") &&
      !path.isAbsolute(media) &&
      !WINDOWS_DRIVE_RE.test(media);
    const sandboxWorkspace = await resolveSandboxWorkspace();
    if (sandboxWorkspace) {
      let sandboxResolvedMedia: string;
      try {
        sandboxResolvedMedia = await resolveSandboxedMediaSource({
          media,
          sandboxRoot: sandboxWorkspace.root,
          containerWorkdir: sandboxWorkspace.containerWorkdir,
        });
      } catch (err) {
        if (FILE_URL_RE.test(media)) {
          throw new Error(
            "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
            { cause: err },
          );
        }
        throw err;
      }
      const persisted = await persistLocalReplyMedia(sandboxResolvedMedia);
      return {
        mediaUrl: persisted.path,
        trustedLocalMedia: true,
        fileName: path.basename(sandboxResolvedMedia),
        ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
      };
    }
    if (isRelativeLocalMedia) {
      const workspaceMedia = resolveWorkspaceRelativeMedia(media);
      const persisted = await persistLocalReplyMedia(workspaceMedia);
      return {
        mediaUrl: persisted.path,
        trustedLocalMedia: true,
        fileName: path.basename(workspaceMedia),
        ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
      };
    }
    if (!isLikelyLocalMediaSource(media)) {
      return { mediaUrl: media, trustedLocalMedia: false };
    }
    if (FILE_URL_RE.test(media)) {
      throw new Error(
        "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
      );
    }
    const persisted = await persistLocalReplyMedia(media);
    return {
      mediaUrl: persisted.path,
      trustedLocalMedia: true,
      fileName: path.basename(media),
      ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
    };
  };

  return async (payload) => {
    const mediaList = getPayloadMediaList(payload);
    if (mediaList.length === 0) {
      return payload;
    }

    const normalizedMedia: string[] = [];
    const normalizedAttachments: NonNullable<ReplyPayload["attachments"]> = [];
    const seen = new Set<string>();
    let hasTrustedLocalMedia = payload.trustedLocalMedia === true;
    let firstMediaDropError: unknown;
    for (const [mediaIndex, media] of mediaList.entries()) {
      let normalized: Awaited<ReturnType<typeof normalizeMediaSource>>;
      try {
        normalized = await normalizeMediaSource(media);
      } catch (err) {
        firstMediaDropError ??= err;
        logVerbose(`dropping blocked reply media ${media}: ${String(err)}`);
        continue;
      }
      if (!normalized.mediaUrl || seen.has(normalized.mediaUrl)) {
        continue;
      }
      seen.add(normalized.mediaUrl);
      normalizedMedia.push(normalized.mediaUrl);
      hasTrustedLocalMedia ||= normalized.trustedLocalMedia;
      const existingAttachment = payload.attachments?.[mediaIndex] ?? {};
      normalizedAttachments.push({
        ...existingAttachment,
        ...(normalized.fileName && !existingAttachment.name ? { name: normalized.fileName } : {}),
        ...(normalized.mimeType && !existingAttachment.mimeType
          ? { mimeType: normalized.mimeType }
          : {}),
        ...(normalized.trustedLocalMedia ? { trustedLocalMedia: true } : {}),
      });
    }

    const text =
      firstMediaDropError === undefined
        ? payload.text
        : appendReplyMediaFailureWarning(payload.text);

    if (normalizedMedia.length === 0) {
      const normalized = copyReplyPayloadMetadata(payload, {
        ...payload,
        text,
        mediaUrl: undefined,
        mediaUrls: undefined,
      });
      return firstMediaDropError === undefined
        ? normalized
        : setReplyPayloadMetadata(normalized, { assistantMediaNormalizationFailed: true });
    }

    const normalized = copyReplyPayloadMetadata(payload, {
      ...payload,
      text,
      mediaUrl: normalizedMedia[0],
      mediaUrls: normalizedMedia,
      ...(normalizedAttachments.some((attachment) => Object.keys(attachment).length > 0)
        ? { attachments: normalizedAttachments }
        : {}),
      ...(hasTrustedLocalMedia ? { trustedLocalMedia: true } : {}),
    });
    return firstMediaDropError === undefined
      ? normalized
      : setReplyPayloadMetadata(normalized, { assistantMediaNormalizationFailed: true });
  };
}

export type ReplyMediaContext = {
  normalizePayload: (payload: ReplyPayload) => Promise<ReplyPayload>;
};

export function createReplyMediaContext(
  params: Parameters<typeof createReplyMediaPathNormalizer>[0],
): ReplyMediaContext {
  return {
    normalizePayload: createReplyMediaPathNormalizer(params),
  };
}
