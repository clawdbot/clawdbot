import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-message";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import {
  convertMarkdownTables,
  fetchWithSsrFGuard,
  generateNextcloudTalkSignature,
  getNextcloudTalkRuntime,
  requireRuntimeConfig,
  resolveMarkdownTableMode,
  resolveNextcloudTalkAccount,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "./send.runtime.js";
import type { CoreConfig, NextcloudTalkSendResult } from "./types.js";

type NextcloudTalkSendOpts = {
  cfg: CoreConfig;
  baseUrl?: string;
  secret?: string;
  accountId?: string;
  replyTo?: string;
  verbose?: boolean;
};

function resolveCredentials(
  explicit: { baseUrl?: string; secret?: string },
  account: { baseUrl: string; secret: string; accountId: string },
): { baseUrl: string; secret: string } {
  const baseUrl = explicit.baseUrl?.trim() ?? account.baseUrl;
  const secret = explicit.secret?.trim() ?? account.secret;

  if (!baseUrl) {
    throw new Error(
      `Nextcloud Talk baseUrl missing for account "${account.accountId}" (set channels.nextcloud-talk.baseUrl).`,
    );
  }
  if (!secret) {
    throw new Error(
      `Nextcloud Talk bot secret missing for account "${account.accountId}" (set channels.nextcloud-talk.botSecret/botSecretFile or NEXTCLOUD_TALK_BOT_SECRET for default).`,
    );
  }

  return { baseUrl, secret };
}

function normalizeRoomToken(to: string): string {
  const normalized = stripNextcloudTalkTargetPrefix(to);
  if (!normalized) {
    throw new Error("Room token is required for Nextcloud Talk sends");
  }
  return normalized;
}

function resolveNextcloudTalkSendContext(opts: NextcloudTalkSendOpts): {
  cfg: CoreConfig;
  account: ReturnType<typeof resolveNextcloudTalkAccount>;
  baseUrl: string;
  secret: string;
} {
  const cfg = requireRuntimeConfig(opts.cfg, "Nextcloud Talk send") as CoreConfig;
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, secret } = resolveCredentials(
    { baseUrl: opts.baseUrl, secret: opts.secret },
    account,
  );
  return { cfg, account, baseUrl, secret };
}

function recordNextcloudTalkOutboundActivity(accountId: string): void {
  try {
    getNextcloudTalkRuntime().channel.activity.record({
      channel: "nextcloud-talk",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Nextcloud Talk runtime not initialized") {
      throw error;
    }
  }
}

function createNextcloudTalkSendReceipt(params: {
  messageId: string;
  roomToken: string;
  replyTo?: string;
}) {
  const messageId = params.messageId.trim();
  return createMessageReceiptFromOutboundResults({
    results:
      messageId && messageId !== "unknown"
        ? [
            {
              channel: "nextcloud-talk",
              messageId,
              conversationId: params.roomToken,
            },
          ]
        : [],
    kind: "text",
    ...(params.replyTo ? { replyToId: params.replyTo } : {}),
  });
}

export async function sendMessageNextcloudTalk(
  to: string,
  text: string,
  opts: NextcloudTalkSendOpts,
): Promise<NextcloudTalkSendResult> {
  const { cfg, account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
  const roomToken = normalizeRoomToken(to);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Nextcloud Talk sends");
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });
  const message = convertMarkdownTables(text.trim(), tableMode);

  const body: Record<string, unknown> = {
    message,
  };
  if (opts.replyTo) {
    body.replyTo = opts.replyTo;
  }
  const bodyStr = JSON.stringify(body);

  // Nextcloud Talk verifies signature against the extracted message text,
  // not the full JSON body. See ChecksumVerificationService.php:
  //   hash_hmac('sha256', $random . $data, $secret)
  // where $data is the "message" parameter, not the raw request body.
  const { random, signature } = generateNextcloudTalkSignature({
    body: message,
    secret,
  });

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/message`;

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body: bodyStr,
    },
    auditContext: "nextcloud-talk-send",
    policy: ssrfPolicyFromPrivateNetworkOptIn(account.config),
  });

  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const status = response.status;
      let errorMsg = `Nextcloud Talk send failed (${status})`;

      if (status === 400) {
        errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
      } else if (status === 401) {
        errorMsg =
          "Nextcloud Talk: bot send was rejected - check the bot secret and ensure the bot was installed with --feature response";
      } else if (status === 403) {
        errorMsg = "Nextcloud Talk: forbidden - bot may not have permission in this room";
      } else if (status === 404) {
        errorMsg = `Nextcloud Talk: room not found (token=${roomToken})`;
      } else if (errorBody) {
        errorMsg = `Nextcloud Talk send failed: ${errorBody}`;
      }

      throw new Error(errorMsg);
    }

    let messageId = "unknown";
    let timestamp: number | undefined;
    try {
      const data = (await response.json()) as {
        ocs?: {
          data?: {
            id?: number | string;
            timestamp?: number;
          };
        };
      };
      if (data.ocs?.data?.id != null) {
        messageId = String(data.ocs.data.id);
      }
      if (typeof data.ocs?.data?.timestamp === "number") {
        timestamp = data.ocs.data.timestamp;
      }
    } catch {
      // Response parsing failed, but message was sent.
    }

    if (opts.verbose) {
      console.log(`[nextcloud-talk] Sent message ${messageId} to room ${roomToken}`);
    }

    recordNextcloudTalkOutboundActivity(account.accountId);

    return {
      messageId,
      roomToken,
      receipt: createNextcloudTalkSendReceipt({
        messageId,
        roomToken,
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      }),
      timestamp,
    };
  } finally {
    await release();
  }
}

export async function sendReactionNextcloudTalk(
  roomToken: string,
  messageId: string,
  reaction: string,
  opts: Omit<NextcloudTalkSendOpts, "replyTo">,
): Promise<{ ok: true }> {
  const { account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
  const normalizedToken = normalizeRoomToken(roomToken);

  const body = JSON.stringify({ reaction });
  // Sign only the reaction string, not the full JSON body
  const { random, signature } = generateNextcloudTalkSignature({
    body: reaction,
    secret,
  });

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${normalizedToken}/reaction/${messageId}`;

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body,
    },
    auditContext: "nextcloud-talk-reaction",
    policy: ssrfPolicyFromPrivateNetworkOptIn(account.config),
  });

  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
    }

    return { ok: true };
  } finally {
    await release();
  }
}
