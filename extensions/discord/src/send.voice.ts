// Discord plugin module implements send.voice behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  buildOutboundMediaLoadOptions,
  extensionForMime,
  maxBytesForKind,
  unlinkIfExists,
} from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { withTempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { resolveDiscordAccount } from "./accounts.js";
import type { RequestClient } from "./internal/discord.js";
import { parseAndResolveChannelRecipient } from "./recipient-resolution.js";
import type { DiscordReplyReference } from "./reply-reference.js";
import type { sendMessageDiscord } from "./send.outbound.js";
import { createDiscordSendResult } from "./send.receipt.js";
import { buildDiscordSendError, createDiscordClient, resolveChannelId } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage,
} from "./voice-message.js";

type VoiceMessageOpts = Pick<
  Parameters<typeof sendMessageDiscord>[2],
  | "cfg"
  | "token"
  | "accountId"
  | "verbose"
  | "rest"
  | "reply"
  | "retry"
  | "silent"
  | "mediaAccess"
  | "mediaLocalRoots"
  | "mediaReadFile"
  | "onPlatformSendDispatch"
>;

function toDiscordSendResult(
  result: { id?: string | null; channel_id?: string | null },
  fallbackChannelId: string,
  reply?: DiscordReplyReference,
): DiscordSendResult {
  return createDiscordSendResult({
    result,
    fallbackChannelId,
    kind: "voice",
    reply,
  });
}

async function withMaterializedVoiceMessageInput<T>(
  mediaUrl: string,
  opts: VoiceMessageOpts,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  // Security: reuse the standard media loader so we apply SSRF guards + allowed-local-root checks.
  // Then write to a private temp file so ffmpeg/ffprobe never sees the original URL/path string.
  const media = await loadWebMediaRaw(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: maxBytesForKind("audio"),
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
    }),
  );
  const extFromName = media.fileName ? path.extname(media.fileName) : "";
  const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
  const ext = extFromName || extFromMime || ".bin";
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "voice-src-",
    },
    async (workspace) => await run(await workspace.write(`input${ext}`, media.buffer)),
  );
}

/**
 * Send a voice message to Discord.
 *
 * Voice messages are a special Discord feature that displays audio with a waveform
 * visualization. They require OGG/Opus format and cannot include text content.
 *
 * @param to - Recipient (user ID for DM or channel ID)
 * @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
 * @param opts - Send options
 */
export async function sendVoiceMessageDiscord(
  to: string,
  audioPath: string,
  opts: VoiceMessageOpts,
): Promise<DiscordSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord voice send");
  return await withMaterializedVoiceMessageInput(audioPath, opts, async (localInputPath) => {
    let oggPath: string | null = null;
    let oggCleanup = false;
    let token: string | undefined;
    let rest: RequestClient | undefined;
    let channelId: string | undefined;

    try {
      const accountInfo = resolveDiscordAccount({
        cfg,
        accountId: opts.accountId,
      });
      const client = createDiscordClient({ ...opts, cfg });
      token = client.token;
      rest = client.rest;
      const request = client.request;
      const recipient = await parseAndResolveChannelRecipient(to, cfg, opts.accountId);
      channelId = (await resolveChannelId(rest, recipient, request)).channelId;

      const ogg = await ensureOggOpus(localInputPath);
      oggPath = ogg.path;
      oggCleanup = ogg.cleanup;

      const metadata = await getVoiceMessageMetadata(oggPath);
      const audioBuffer = await fs.readFile(oggPath);
      await opts.onPlatformSendDispatch?.();
      const result = await sendDiscordVoiceMessage(
        rest,
        channelId,
        audioBuffer,
        metadata,
        opts.reply?.messageId,
        request,
        opts.silent,
        token,
      );

      recordChannelActivity({
        channel: "discord",
        accountId: accountInfo.accountId,
        direction: "outbound",
      });

      return toDiscordSendResult(result, channelId, opts.reply);
    } catch (err) {
      if (channelId && rest && token) {
        throw await buildDiscordSendError(err, {
          channelId,
          cfg,
          rest,
          token,
          hasMedia: true,
        });
      }
      throw err;
    } finally {
      await unlinkIfExists(oggCleanup ? oggPath : null);
    }
  });
}
