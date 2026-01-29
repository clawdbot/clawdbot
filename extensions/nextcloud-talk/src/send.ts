import { resolveNextcloudTalkAccount } from "./accounts.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { CoreConfig, NextcloudTalkSendResult } from "./types.js";

type NextcloudTalkSendOpts = {
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
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Room token is required for Nextcloud Talk sends");

  let normalized = trimmed;
  if (normalized.startsWith("nextcloud-talk:")) {
    normalized = normalized.slice("nextcloud-talk:".length).trim();
  } else if (normalized.startsWith("nc:")) {
    normalized = normalized.slice("nc:".length).trim();
  }

  if (normalized.startsWith("room:")) {
    normalized = normalized.slice("room:".length).trim();
  }

  if (!normalized) throw new Error("Room token is required for Nextcloud Talk sends");
  return normalized;
}

export async function sendMessageNextcloudTalk(
  to: string,
  text: string,
  opts: NextcloudTalkSendOpts = {},
): Promise<NextcloudTalkSendResult> {
  const cfg = getNextcloudTalkRuntime().config.loadConfig() as CoreConfig;
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, secret } = resolveCredentials(
    { baseUrl: opts.baseUrl, secret: opts.secret },
    account,
  );
  const roomToken = normalizeRoomToken(to);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Nextcloud Talk sends");
  }

  const tableMode = getNextcloudTalkRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });
  const message = getNextcloudTalkRuntime().channel.text.convertMarkdownTables(
    text.trim(),
    tableMode,
  );

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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Random": random,
      "X-Nextcloud-Talk-Bot-Signature": signature,
    },
    body: bodyStr,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const status = response.status;
    let errorMsg = `Nextcloud Talk send failed (${status})`;

    if (status === 400) {
      errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
    } else if (status === 401) {
      errorMsg = "Nextcloud Talk: authentication failed - check bot secret";
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

  getNextcloudTalkRuntime().channel.activity.record({
    channel: "nextcloud-talk",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId, roomToken, timestamp };
}

export async function sendReactionNextcloudTalk(
  roomToken: string,
  messageId: string,
  reaction: string,
  opts: Omit<NextcloudTalkSendOpts, "replyTo"> = {},
): Promise<{ ok: true }> {
  const cfg = getNextcloudTalkRuntime().config.loadConfig() as CoreConfig;
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, secret } = resolveCredentials(
    { baseUrl: opts.baseUrl, secret: opts.secret },
    account,
  );
  const normalizedToken = normalizeRoomToken(roomToken);

  const body = JSON.stringify({ reaction });
  // Sign only the reaction string, not the full JSON body
  const { random, signature } = generateNextcloudTalkSignature({
    body: reaction,
    secret,
  });

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${normalizedToken}/reaction/${messageId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Random": random,
      "X-Nextcloud-Talk-Bot-Signature": signature,
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
  }

  return { ok: true };
}
