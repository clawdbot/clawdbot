import { ChannelType, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createDiscordRestClient } from "../client.js";
import { sendMessageDiscord, sendWebhookMessageDiscord } from "../send.js";
import { createThreadDiscord } from "../send.messages.js";
import { resolveThreadBindingPersonaFromRecord } from "./thread-bindings.persona.js";
import {
  BINDINGS_BY_THREAD_ID,
  REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL,
  rememberReusableWebhook,
  toReusableWebhookKey,
} from "./thread-bindings.state.js";
import {
  DISCORD_UNKNOWN_CHANNEL_ERROR_CODE,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

function buildThreadTarget(threadId: string): string {
  return /^(channel:|user:)/i.test(threadId) ? threadId : `channel:${threadId}`;
}

export function isThreadArchived(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const asRecord = raw as {
    archived?: unknown;
    thread_metadata?: { archived?: unknown };
    threadMetadata?: { archived?: unknown };
  };
  if (asRecord.archived === true) {
    return true;
  }
  if (asRecord.thread_metadata?.archived === true) {
    return true;
  }
  if (asRecord.threadMetadata?.archived === true) {
    return true;
  }
  return false;
}

function isThreadChannelType(type: unknown): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

export function summarizeDiscordError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint" ||
    typeof err === "symbol"
  ) {
    return String(err);
  }
  return "error";
}

function extractNumericDiscordErrorValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

function extractDiscordErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return (
    extractNumericDiscordErrorValue(candidate.status) ??
    extractNumericDiscordErrorValue(candidate.statusCode) ??
    extractNumericDiscordErrorValue(candidate.response?.status)
  );
}

function extractDiscordErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as {
    code?: unknown;
    rawError?: { code?: unknown };
    body?: { code?: unknown };
    response?: { body?: { code?: unknown }; data?: { code?: unknown } };
  };
  return (
    extractNumericDiscordErrorValue(candidate.code) ??
    extractNumericDiscordErrorValue(candidate.rawError?.code) ??
    extractNumericDiscordErrorValue(candidate.body?.code) ??
    extractNumericDiscordErrorValue(candidate.response?.body?.code) ??
    extractNumericDiscordErrorValue(candidate.response?.data?.code)
  );
}

export function isDiscordThreadGoneError(err: unknown): boolean {
  const code = extractDiscordErrorCode(err);
  if (code === DISCORD_UNKNOWN_CHANNEL_ERROR_CODE) {
    return true;
  }
  const status = extractDiscordErrorStatus(err);
  // 404: deleted/unknown channel. 403: bot no longer has access.
  return status === 404 || status === 403;
}

export async function maybeSendBindingMessage(params: {
  cfg: OpenClawConfig;
  record: ThreadBindingRecord;
  text: string;
  preferWebhook?: boolean;
}) {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const record = params.record;
  if (params.preferWebhook !== false && record.webhookId && record.webhookToken) {
    try {
      await sendWebhookMessageDiscord(text, {
        cfg: params.cfg,
        webhookId: record.webhookId,
        webhookToken: record.webhookToken,
        accountId: record.accountId,
        threadId: record.threadId,
        username: resolveThreadBindingPersonaFromRecord(record),
      });
      return;
    } catch (err) {
      logVerbose(`discord thread binding webhook send failed: ${summarizeDiscordError(err)}`);
    }
  }
  try {
    await sendMessageDiscord(buildThreadTarget(record.threadId), text, {
      cfg: params.cfg,
      accountId: record.accountId,
    });
  } catch (err) {
    logVerbose(`discord thread binding fallback send failed: ${summarizeDiscordError(err)}`);
  }
}

export async function createWebhookForChannel(params: {
  cfg?: OpenClawConfig;
  accountId: string;
  token?: string;
  channelId: string;
}): Promise<{ webhookId?: string; webhookToken?: string }> {
  try {
    const rest = createDiscordRestClient(
      {
        accountId: params.accountId,
        token: params.token,
      },
      params.cfg,
    ).rest;
    const created = (await rest.post(Routes.channelWebhooks(params.channelId), {
      body: {
        name: "OpenClaw Agents",
      },
    })) as { id?: string; token?: string };
    const webhookId = normalizeOptionalString(created?.id) ?? "";
    const webhookToken = normalizeOptionalString(created?.token) ?? "";
    if (!webhookId || !webhookToken) {
      return {};
    }
    return { webhookId, webhookToken };
  } catch (err) {
    logVerbose(
      `discord thread binding webhook create failed for ${params.channelId}: ${summarizeDiscordError(err)}`,
    );
    return {};
  }
}

export function findReusableWebhook(params: { accountId: string; channelId: string }): {
  webhookId?: string;
  webhookToken?: string;
} {
  const reusableKey = toReusableWebhookKey({
    accountId: params.accountId,
    channelId: params.channelId,
  });
  const cached = REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.get(reusableKey);
  if (cached) {
    return {
      webhookId: cached.webhookId,
      webhookToken: cached.webhookToken,
    };
  }
  for (const record of BINDINGS_BY_THREAD_ID.values()) {
    if (record.accountId !== params.accountId) {
      continue;
    }
    if (record.channelId !== params.channelId) {
      continue;
    }
    if (!record.webhookId || !record.webhookToken) {
      continue;
    }
    rememberReusableWebhook(record);
    return {
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
    };
  }
  return {};
}

export async function resolveChannelIdForBinding(params: {
  cfg?: OpenClawConfig;
  accountId: string;
  token?: string;
  threadId: string;
  channelId?: string;
}): Promise<string | null> {
  const explicit = params.channelId?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    const rest = createDiscordRestClient(
      {
        accountId: params.accountId,
        token: params.token,
      },
      params.cfg,
    ).rest;
    const channel = (await rest.get(Routes.channel(params.threadId))) as {
      id?: string;
      type?: number;
      parent_id?: string;
      parentId?: string;
    };
    const channelId = normalizeOptionalString(channel?.id) ?? "";
    const type = channel?.type;
    const parentId =
      typeof channel?.parent_id === "string"
        ? channel.parent_id.trim()
        : typeof channel?.parentId === "string"
          ? channel.parentId.trim()
          : "";
    // Only thread channels should resolve to their parent channel.
    // Non-thread channels (text/forum/media) must keep their own ID.
    if (parentId && isThreadChannelType(type)) {
      return parentId;
    }
    return channelId || null;
  } catch (err) {
    logVerbose(
      `discord thread binding channel resolve failed for ${params.threadId}: ${summarizeDiscordError(err)}`,
    );
    return null;
  }
}

export async function createThreadForBinding(params: {
  cfg?: OpenClawConfig;
  accountId: string;
  token?: string;
  channelId: string;
  threadName: string;
}): Promise<string | null> {
  try {
    const created = await createThreadDiscord(
      params.channelId,
      {
        name: params.threadName,
        autoArchiveMinutes: 60,
      },
      {
        cfg: params.cfg,
        accountId: params.accountId,
        token: params.token,
      },
    );
    const createdId = normalizeOptionalString(created?.id) ?? "";
    return createdId || null;
  } catch (err) {
    logVerbose(
      `discord thread binding auto-thread create failed for ${params.channelId}: ${summarizeDiscordError(err)}`,
    );
    return null;
  }
}
