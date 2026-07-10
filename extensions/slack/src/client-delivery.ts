// Slack plugin module owns WebClient-scoped message and file delivery primitives.
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  postSlackMessageWithIdentityFallback,
  type SlackPostMessageIdentity,
} from "./post-message-identity.js";
import {
  appendSlackDataVisualizationFallbackText,
  hasSlackDataVisualizationBlock,
  isSlackInvalidBlocksError,
} from "./data-visualization.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import {
  buildSlackPostMessagePayload,
  type SlackPostMessagePayload,
  type SlackUnfurlOptions,
} from "./post-message-payload.js";
import { loadOutboundMediaFromUrl } from "./runtime-api.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_UPLOAD_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true,
};
const SLACK_DNS_RETRY_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "UND_ERR_DNS_RESOLVE_FAILED"]);
const SLACK_DNS_RETRY_ATTEMPTS = 2;
const SLACK_DNS_RETRY_BASE_DELAY_MS = 250;

function readSlackRequestErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function readSlackRequestErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === "string" ? value : "";
}

function hasSlackDnsRequestSignal(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    const code = readSlackRequestErrorCode(current);
    if (code && SLACK_DNS_RETRY_CODES.has(code)) {
      return true;
    }
    const message = readSlackRequestErrorMessage(current);
    if (/\b(EAI_AGAIN|ENOTFOUND|UND_ERR_DNS_RESOLVE_FAILED)\b/i.test(message)) {
      return true;
    }
    current =
      (current as { original?: unknown; cause?: unknown }).original ??
      (current as { cause?: unknown }).cause;
  }
  return false;
}

function delaySlackDnsRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SLACK_DNS_RETRY_BASE_DELAY_MS * Math.max(1, attempt));
  });
}

export async function withSlackDnsRequestRetry<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (const attempt of Array.from({ length: SLACK_DNS_RETRY_ATTEMPTS + 1 }, (_, index) => index)) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= SLACK_DNS_RETRY_ATTEMPTS || !hasSlackDnsRequestSignal(err)) {
        throw err;
      }
      logVerbose(
        `slack send: retrying ${operation} after transient DNS request error (${attempt + 1}/${SLACK_DNS_RETRY_ATTEMPTS})`,
      );
      await delaySlackDnsRetry(attempt + 1);
    }
  }
  throw new Error("unreachable Slack DNS retry loop exit");
}

export async function postSlackMessageBestEffort(params: {
  client: WebClient;
  channelId: string;
  text: string;
  threadTs?: string;
  replyBroadcast?: boolean;
  identity?: SlackPostMessageIdentity;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  unfurl?: SlackUnfurlOptions;
}) {
  const basePayload = buildSlackPostMessagePayload(params);
  const postChatMessage = params.client.chat.postMessage.bind(params.client.chat);
  const post = async (payload: SlackPostMessagePayload, identity?: SlackPostMessageIdentity) => {
    try {
      return {
        response: await withSlackDnsRequestRetry("chat.postMessage", () =>
          postChatMessage(payload),
        ),
        identity,
      };
    } catch (error) {
      if (!hasSlackDataVisualizationBlock(payload.blocks) || !isSlackInvalidBlocksError(error)) {
        throw error;
      }
      const { blocks, ...textPayload } = payload;
      // Slack rejects unsupported chart blocks before posting, so one text-only
      // retry preserves the complete accessible summary without duplicating a send.
      logVerbose("slack send: data visualization rejected, retrying with text fallback");
      return {
        response: await withSlackDnsRequestRetry("chat.postMessage", () =>
          postChatMessage({
            ...textPayload,
            text: truncateSlackText(
              appendSlackDataVisualizationFallbackText(payload.text ?? "", blocks),
              SLACK_TEXT_LIMIT,
            ),
          }),
        ),
        identity,
      };
    }
  };
  return await postSlackMessageWithIdentityFallback({
    basePayload,
    identity: params.identity,
    post,
  });
}

export async function uploadSlackFile(params: {
  client: WebClient;
  channelId: string;
  mediaUrl: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  caption?: string;
  threadTs?: string;
  maxBytes?: number;
  onPlatformSendDispatch?: () => Promise<void>;
  auditContext?: string;
}): Promise<string> {
  const { buffer, contentType, fileName } = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const uploadFileName = params.uploadFileName ?? fileName ?? "upload";
  const uploadTitle = params.uploadTitle ?? uploadFileName;
  const uploadUrlResp = await withSlackDnsRequestRetry("files.getUploadURLExternal", () =>
    params.client.files.getUploadURLExternal({
      filename: uploadFileName,
      length: buffer.length,
    }),
  );
  if (!uploadUrlResp.ok || !uploadUrlResp.upload_url || !uploadUrlResp.file_id) {
    throw new Error(`Failed to get upload URL: ${uploadUrlResp.error ?? "unknown error"}`);
  }
  const uploadFileId = uploadUrlResp.file_id;
  const { response: uploadResp, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: uploadUrlResp.upload_url,
      init: {
        method: "POST",
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
        body: new Uint8Array(buffer) as BodyInit,
      },
      policy: SLACK_UPLOAD_SSRF_POLICY,
      auditContext: params.auditContext ?? "slack-upload-file",
    }),
  );
  try {
    if (!uploadResp.ok) {
      throw new Error(`Failed to upload file: HTTP ${uploadResp.status}`);
    }
  } finally {
    await release();
  }

  await params.onPlatformSendDispatch?.();
  const completeResp = await withSlackDnsRequestRetry("files.completeUploadExternal", () =>
    params.client.files.completeUploadExternal({
      files: [{ id: uploadFileId, title: uploadTitle }],
      channel_id: params.channelId,
      ...(params.caption ? { initial_comment: params.caption } : {}),
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    }),
  );
  if (!completeResp.ok) {
    throw new Error(`Failed to complete upload: ${completeResp.error ?? "unknown error"}`);
  }
  return uploadFileId;
}
