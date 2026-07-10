// Slack plugin module implements send behavior.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeOptionalString as normalizeSlackApiString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackTokenSource } from "./accounts.js";
import { resolveSlackAccount, resolveSlackOperationToken } from "./accounts.js";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import {
  postSlackMessageBestEffort,
  uploadSlackFile,
  withSlackDnsRequestRetry,
} from "./client-delivery.js";
import { createSlackTokenCacheKey, createSlackWebClient, getSlackWriteClient } from "./client.js";
import { appendSlackDataVisualizationFallbackText } from "./data-visualization.js";
import { assertSlackDirectSendAllowed } from "./direct-send-admission.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { recordSlackThreadParticipation } from "./sent-thread-cache.js";
import { canonicalizeSlackApiTargetId, parseSlackTarget } from "./target-parsing.js";
import { normalizeSlackThreadTsCandidate, resolveSlackThreadTsValue } from "./thread-ts.js";
import { resolveSlackBotToken } from "./token.js";
import { truncateSlackText } from "./truncate.js";
const SLACK_DM_CHANNEL_CACHE_MAX = 1024;
const SLACK_DELIVERY_METADATA_EVENT = "openclaw_delivery";
const SLACK_DELIVERY_METADATA_KEY = "openclaw_delivery_id";
const SLACK_DELIVERY_METADATA_PART_INDEX_KEY = "openclaw_delivery_part_index";
const SLACK_DELIVERY_METADATA_PART_COUNT_KEY = "openclaw_delivery_part_count";
const SLACK_DELIVERY_METADATA_SIGNATURE_KEY = "openclaw_delivery_signature";
const SLACK_RECONCILE_LOOKBACK_MS = 30_000;
const SLACK_RECONCILE_CLOCK_SKEW_MS = 5 * 60_000;
const SLACK_RECONCILE_LIMIT = 100;
const SLACK_RECONCILE_MAX_PAGES = 10;
const SLACK_ENTERPRISE_LISTENER_QUEUE_CREDENTIAL = "listener-scoped-enterprise";
const slackDmChannelCache = new Map<string, string>();
const slackSendQueue = new KeyedAsyncQueue();

type SlackRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export type SlackSendIdentity = {
  username?: string;
  iconUrl?: string;
  iconEmoji?: string;
};

type SlackEnterpriseEventScope = Readonly<{
  apiAppId: string;
  enterpriseId: string;
  teamId: string;
  isEnterpriseInstall: true;
  client: WebClient;
  uploadCompletionClient?: WebClient;
}>;

type SlackEnterpriseDelivery = Readonly<{
  client: WebClient;
  teamId: string;
  uploadCompletionClient?: WebClient;
}>;

const slackDefaultSendIdentities = new Map<string, SlackSendIdentity>();

type SlackSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  client?: WebClient;
  /** Monitor-private proof that `client` belongs to the validated Enterprise event turn. */
  enterpriseEventScope?: SlackEnterpriseEventScope;
  /** Monitor-private delivery limits already resolved for the active listener. */
  textLimit?: number;
  mediaMaxBytes?: number;
  threadTs?: string;
  replyBroadcast?: boolean;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  /** Opaque durable intent id used to reconcile ambiguous platform outcomes. */
  deliveryQueueId?: string;
  /** Refresh durable timing before recipient-visible or finalizing platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** Persist each concrete platform send before any later chunk can fail. */
  onDeliveryResult?: (result: SlackSendResult) => Promise<void> | void;
};

type SlackWebApiErrorData = {
  error?: unknown;
  needed?: unknown;
  response_metadata?: {
    scopes?: unknown;
    acceptedScopes?: unknown;
  };
};

type SlackWebApiError = Error & {
  data?: SlackWebApiErrorData;
};

function hasCustomIdentity(identity?: SlackSendIdentity): boolean {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}

function normalizeSlackSendIdentity(identity?: SlackSendIdentity): SlackSendIdentity | undefined {
  const username = normalizeOptionalString(identity?.username);
  const iconUrl = normalizeOptionalString(identity?.iconUrl);
  const iconEmoji = normalizeOptionalString(identity?.iconEmoji);
  const normalized = {
    ...(username ? { username } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(iconEmoji ? { iconEmoji } : {}),
  };
  return hasCustomIdentity(normalized) ? normalized : undefined;
}

export function setSlackDefaultSendIdentity(accountId: string, identity?: SlackSendIdentity): void {
  const normalizedAccountId = normalizeOptionalString(accountId);
  if (!normalizedAccountId) {
    return;
  }
  const normalizedIdentity = normalizeSlackSendIdentity(identity);
  if (normalizedIdentity) {
    slackDefaultSendIdentities.set(normalizedAccountId, normalizedIdentity);
  } else {
    slackDefaultSendIdentities.delete(normalizedAccountId);
  }
}

function getSlackDefaultSendIdentity(accountId: string): SlackSendIdentity | undefined {
  const normalizedAccountId = normalizeOptionalString(accountId);
  return normalizedAccountId ? slackDefaultSendIdentities.get(normalizedAccountId) : undefined;
}

function resolveSlackSendIdentity(params: {
  accountId: string;
  explicit?: SlackSendIdentity;
}): SlackSendIdentity | undefined {
  return (
    normalizeSlackSendIdentity(params.explicit) ?? getSlackDefaultSendIdentity(params.accountId)
  );
}

function normalizeSlackScopeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((scope) => {
    const normalized = normalizeSlackApiString(scope);
    return normalized ? [normalized] : [];
  });
}

function getSlackWebApiErrorData(err: unknown): SlackWebApiErrorData | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const data = (err as SlackWebApiError).data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return data;
}

function formatSlackWebApiErrorMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const data = getSlackWebApiErrorData(err);
  const code = normalizeSlackApiString(data?.error);
  if (!code) {
    return undefined;
  }
  const details: string[] = [];
  const needed = normalizeSlackApiString(data?.needed);
  if (needed) {
    details.push(`needed: ${needed}`);
  }
  const scopes = normalizeSlackScopeList(data?.response_metadata?.scopes);
  if (scopes.length) {
    details.push(`granted: ${scopes.join(", ")}`);
  }
  const acceptedScopes = normalizeSlackScopeList(data?.response_metadata?.acceptedScopes);
  if (acceptedScopes.length) {
    details.push(`accepted: ${acceptedScopes.join(", ")}`);
  }
  return `${err.message || `An API error occurred: ${code}`}${
    details.length ? ` (${details.join("; ")})` : ""
  }`;
}

function enrichSlackWebApiError(err: unknown): unknown {
  const message = formatSlackWebApiErrorMessage(err);
  if (!message || !(err instanceof Error) || message === err.message) {
    return err;
  }
  return new Error(message);
}

function readSlackRequestErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === "string" ? value : "";
}

function resolvePostedMessageThreadTs(response: {
  message?: { thread_ts?: unknown };
}): string | undefined {
  const threadTs = response.message?.thread_ts;
  return typeof threadTs === "string" ? normalizeSlackThreadTsCandidate(threadTs) : undefined;
}

export type SlackSendResult = {
  messageId: string;
  channelId: string;
  receipt: MessageReceipt;
  threadTs?: string;
};

type SlackConversationMessage = {
  ts?: unknown;
  thread_ts?: unknown;
  metadata?: unknown;
};

type SlackConversationLookupResponse = {
  messages?: unknown;
  has_more?: unknown;
  response_metadata?: { next_cursor?: unknown };
};

type SlackConversationLookupClient = Pick<WebClient, "conversations">;

function createSlackSendReceipt(params: {
  platformMessageIds: readonly string[];
  channelId?: string;
  kind: MessageReceiptPartKind;
  threadTs?: string;
}): MessageReceipt {
  const platformMessageIds = params.platformMessageIds
    .map((messageId) => messageId.trim())
    .filter((messageId) => messageId && messageId !== "unknown" && messageId !== "suppressed");
  return createMessageReceiptFromOutboundResults({
    results: platformMessageIds.map((messageId) => {
      const result: MessageReceiptSourceResult = {
        channel: "slack",
        messageId,
      };
      if (params.channelId) {
        result.channelId = params.channelId;
      }
      return result;
    }),
    kind: params.kind,
    threadId: params.threadTs,
  });
}

function resolveToken(params: {
  explicit?: string;
  accountId: string;
  fallbackToken?: string;
  fallbackSource?: SlackTokenSource;
}) {
  const explicit = resolveSlackBotToken(params.explicit);
  if (explicit) {
    return explicit;
  }
  const fallback = resolveSlackBotToken(params.fallbackToken);
  if (!fallback) {
    logVerbose(
      `slack send: missing bot token for account=${params.accountId} explicit=${Boolean(
        params.explicit,
      )} source=${params.fallbackSource ?? "unknown"}`,
    );
    throw new Error(
      `Slack bot token missing for account "${params.accountId}" (set channels.slack.accounts.${params.accountId}.botToken or SLACK_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function parseRecipient(raw: string): SlackRecipient {
  const target = parseSlackTarget(raw);
  if (!target) {
    throw new Error("Recipient is required for Slack sends");
  }
  return {
    kind: target.kind,
    id: canonicalizeSlackApiTargetId(target.kind, target.id, raw),
  };
}

function parseEnterpriseEventRecipient(raw: string): SlackRecipient {
  const match = /^(?:channel:)?([CDG][A-Z0-9]+)$/i.exec(raw.trim());
  if (!match?.[1]) {
    throw new Error("unsupported_enterprise_slack_delivery_target");
  }
  return { kind: "channel", id: canonicalizeSlackApiTargetId("channel", match[1]) };
}

function resolveEnterpriseEventScope(params: {
  account: ReturnType<typeof resolveSlackAccount>;
  opts: SlackSendOpts;
}): SlackEnterpriseEventScope | undefined {
  const scope = params.opts.enterpriseEventScope;
  if (!scope) {
    assertSlackDirectSendAllowed(params.account);
    return undefined;
  }
  if (params.account.config.enterpriseOrgInstall !== true) {
    throw new Error("unexpected_enterprise_slack_listener_scope");
  }
  if (
    !scope.isEnterpriseInstall ||
    !normalizeOptionalString(scope.apiAppId) ||
    !normalizeOptionalString(scope.enterpriseId) ||
    !/^T[A-Z0-9]+$/i.test(scope.teamId) ||
    !scope.client ||
    params.opts.client !== scope.client
  ) {
    throw new Error("invalid_enterprise_slack_listener_scope");
  }
  return scope;
}

function resolveSlackTextChunks(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  text: string;
  textLimit?: number;
}): string[] {
  const text = params.text.trim();
  const configuredLimit =
    params.textLimit ??
    resolveTextChunkLimit(params.cfg, "slack", params.accountId, {
      fallbackLimit: SLACK_TEXT_LIMIT,
    });
  const chunkLimit = Math.min(configuredLimit, SLACK_TEXT_LIMIT);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "slack",
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  const chunkMode = resolveChunkMode(params.cfg, "slack", params.accountId);
  const markdownChunks =
    chunkMode === "newline" ? chunkMarkdownTextWithMode(text, chunkLimit, chunkMode) : [text];
  const chunks = markdownChunks.flatMap((markdown) =>
    markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }),
  );
  return resolveTextChunksWithFallback(text, chunks);
}

function createSlackSendQueueKey(params: {
  accountId: string;
  token: string;
  recipient: SlackRecipient;
  threadTs?: string;
  teamId?: string;
}): string {
  const recipientKey = `${params.recipient.kind}:${params.recipient.id}`;
  const workspaceScope = params.teamId ? `:${params.teamId}` : "";
  return `${params.accountId}:${createSlackTokenCacheKey(params.token)}${workspaceScope}:${recipientKey}:${
    params.threadTs ?? ""
  }`;
}

async function runQueuedSlackSend<T>(key: string, task: () => Promise<T>): Promise<T> {
  return await slackSendQueue.enqueue(key, task);
}

function createSlackDmCacheKey(params: {
  accountId?: string;
  token: string;
  recipientId: string;
}): string {
  return `${params.accountId ?? "default"}:${createSlackTokenCacheKey(params.token)}:${
    params.recipientId
  }`;
}

function setSlackDmChannelCache(key: string, channelId: string): void {
  if (slackDmChannelCache.has(key)) {
    slackDmChannelCache.delete(key);
  } else if (slackDmChannelCache.size >= SLACK_DM_CHANNEL_CACHE_MAX) {
    const oldest = slackDmChannelCache.keys().next().value;
    if (oldest) {
      slackDmChannelCache.delete(oldest);
    }
  }
  slackDmChannelCache.set(key, channelId);
}

function isSlackUserRecipient(recipient: SlackRecipient): boolean {
  return recipient.kind === "user";
}

function resolveDirectUserPostChannelId(params: {
  recipient: SlackRecipient;
  hasMedia: boolean;
  threadTs?: string;
}): string | undefined {
  if (!isSlackUserRecipient(params.recipient) || params.hasMedia || params.threadTs) {
    return undefined;
  }
  return params.recipient.id;
}

function resolvePostedMessageChannelId(response: { channel?: unknown }, fallback: string): string {
  return (
    (typeof response.channel === "string" ? normalizeOptionalString(response.channel) : null) ??
    fallback
  );
}

async function resolveChannelId(
  client: WebClient,
  recipient: SlackRecipient,
  params: { accountId?: string; token: string },
): Promise<{ channelId: string; isDm?: boolean; cacheHit?: boolean }> {
  // Bare Slack user IDs are classified as user recipients by target parsing.
  // chat.postMessage tolerates user IDs directly, but
  // files.uploadV2 → completeUploadExternal validates channel_id against
  // ^[CGDZ][A-Z0-9]{8,}$ and rejects user IDs. Resolve them via
  // conversations.open only for paths that require the concrete DM channel ID.
  if (!isSlackUserRecipient(recipient)) {
    return { channelId: recipient.id };
  }
  const cacheKey = createSlackDmCacheKey({
    accountId: params.accountId,
    token: params.token,
    recipientId: recipient.id,
  });
  const cachedChannelId = slackDmChannelCache.get(cacheKey);
  if (cachedChannelId) {
    return { channelId: cachedChannelId, isDm: true, cacheHit: true };
  }
  const response = await withSlackDnsRequestRetry("conversations.open", () =>
    client.conversations.open({ users: recipient.id }),
  );
  const channelId = response.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open Slack DM channel");
  }
  setSlackDmChannelCache(cacheKey, channelId);
  return { channelId, isDm: true, cacheHit: false };
}

export async function resolveSlackDmChannelId(params: {
  client: WebClient;
  userId: string;
  accountId?: string;
  token: string;
}): Promise<string> {
  const resolved = await resolveChannelId(
    params.client,
    { kind: "user", id: params.userId },
    { accountId: params.accountId, token: params.token },
  );
  return resolved.channelId;
}

export function clearSlackDmChannelCache(): void {
  slackDmChannelCache.clear();
}

export function clearSlackDefaultSendIdentitiesForTest(): void {
  slackDefaultSendIdentities.clear();
}

function createSlackDeliveryMetadataId(queueId?: string): string | undefined {
  const normalized = normalizeOptionalString(queueId);
  if (!normalized) {
    return undefined;
  }
  // Slack metadata is visible to workspace apps and members. Keep the durable
  // store key inside OpenClaw while retaining a stable provider-side marker.
  return createHash("sha256").update(normalized).digest("base64url");
}

function createSlackDeliveryMetadataSignature(params: {
  queueId: string;
  channelId: string;
  threadTs?: string;
  partIndex: number;
  partCount: number;
}): string {
  return createHmac("sha256", params.queueId)
    .update(
      JSON.stringify([
        SLACK_DELIVERY_METADATA_EVENT,
        params.channelId,
        params.threadTs ?? "",
        params.partIndex,
        params.partCount,
      ]),
    )
    .digest("base64url");
}

function matchesSlackDeliveryMetadataSignature(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function withSlackDeliveryMetadata(
  metadata: MessageMetadata | undefined,
  params: {
    queueId?: string;
    channelId: string;
    threadTs?: string;
    partIndex: number;
    partCount: number;
  },
): MessageMetadata | undefined {
  const queueId = normalizeOptionalString(params.queueId);
  const deliveryId = createSlackDeliveryMetadataId(queueId);
  if (!queueId || !deliveryId) {
    return metadata;
  }
  const marker = {
    [SLACK_DELIVERY_METADATA_KEY]: deliveryId,
    [SLACK_DELIVERY_METADATA_PART_INDEX_KEY]: params.partIndex,
    [SLACK_DELIVERY_METADATA_PART_COUNT_KEY]: params.partCount,
    [SLACK_DELIVERY_METADATA_SIGNATURE_KEY]: createSlackDeliveryMetadataSignature({
      queueId,
      channelId: params.channelId,
      threadTs: params.threadTs,
      partIndex: params.partIndex,
      partCount: params.partCount,
    }),
  };
  if (!metadata) {
    return {
      event_type: SLACK_DELIVERY_METADATA_EVENT,
      event_payload: marker,
    };
  }
  return {
    ...metadata,
    event_payload: {
      ...metadata.event_payload,
      ...marker,
    },
  };
}

function formatSlackTimestampFromMs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(6);
}

function asSlackConversationMessages(
  response: SlackConversationLookupResponse,
): SlackConversationMessage[] {
  return Array.isArray(response.messages)
    ? response.messages.filter(
        (message): message is SlackConversationMessage =>
          typeof message === "object" && message !== null && !Array.isArray(message),
      )
    : [];
}

type SlackDeliveryPart = {
  messageId: string;
  threadTs?: string;
  partIndex: number;
  partCount: number;
};

type SlackConversationDeliveryScan = {
  reconciliation: ChannelMessageUnknownSendReconciliationResult;
  evidence: "none" | "partial" | "conflict" | "complete";
};

const SLACK_RECONCILIATION_EVIDENCE_RANK = {
  none: 0,
  partial: 1,
  conflict: 2,
  complete: 3,
} as const satisfies Record<SlackConversationDeliveryScan["evidence"], number>;

function findSlackConversationDeliveryParts(params: {
  messages: readonly SlackConversationMessage[];
  queueId: string;
  deliveryId: string;
  channelId: string;
  threadTs?: string;
}): SlackDeliveryPart[] {
  const matches: SlackDeliveryPart[] = [];
  for (const message of params.messages) {
    if (
      !message.metadata ||
      typeof message.metadata !== "object" ||
      Array.isArray(message.metadata)
    ) {
      continue;
    }
    const eventPayload = (message.metadata as { event_payload?: unknown }).event_payload;
    if (!eventPayload || typeof eventPayload !== "object" || Array.isArray(eventPayload)) {
      continue;
    }
    const marker = eventPayload as Record<string, unknown>;
    if (marker[SLACK_DELIVERY_METADATA_KEY] !== params.deliveryId) {
      continue;
    }
    const partIndex = marker[SLACK_DELIVERY_METADATA_PART_INDEX_KEY];
    const partCount = marker[SLACK_DELIVERY_METADATA_PART_COUNT_KEY];
    if (
      typeof partIndex !== "number" ||
      !Number.isInteger(partIndex) ||
      typeof partCount !== "number" ||
      !Number.isInteger(partCount) ||
      partIndex < 0 ||
      partCount <= 0 ||
      partIndex >= partCount
    ) {
      continue;
    }
    const expectedSignature = createSlackDeliveryMetadataSignature({
      queueId: params.queueId,
      channelId: params.channelId,
      threadTs: params.threadTs,
      partIndex,
      partCount,
    });
    if (
      !matchesSlackDeliveryMetadataSignature(
        marker[SLACK_DELIVERY_METADATA_SIGNATURE_KEY],
        expectedSignature,
      )
    ) {
      continue;
    }
    const messageId =
      typeof message.ts === "string" ? normalizeSlackThreadTsCandidate(message.ts) : undefined;
    if (!messageId) {
      continue;
    }
    const threadTs =
      typeof message.thread_ts === "string"
        ? normalizeSlackThreadTsCandidate(message.thread_ts)
        : undefined;
    matches.push({ messageId, partIndex, partCount, ...(threadTs ? { threadTs } : {}) });
  }
  return matches;
}

async function scanSlackConversationForDelivery(params: {
  client: SlackConversationLookupClient;
  channelId: string;
  threadTs?: string;
  oldest: string;
  latest: string;
  queueId: string;
  deliveryId: string;
  retryCount: number;
}): Promise<SlackConversationDeliveryScan> {
  const threadTs = params.threadTs;
  let cursor: string | undefined;
  let expectedPartCount: number | undefined;
  const deliveryParts = new Map<number, SlackDeliveryPart>();
  for (let page = 0; page < SLACK_RECONCILE_MAX_PAGES; page += 1) {
    const response = (
      threadTs
        ? await withSlackDnsRequestRetry("conversations.replies", () =>
            params.client.conversations.replies({
              channel: params.channelId,
              ts: threadTs,
              oldest: params.oldest,
              latest: params.latest,
              include_all_metadata: true,
              limit: SLACK_RECONCILE_LIMIT,
              ...(cursor ? { cursor } : {}),
            }),
          )
        : await withSlackDnsRequestRetry("conversations.history", () =>
            params.client.conversations.history({
              channel: params.channelId,
              oldest: params.oldest,
              latest: params.latest,
              include_all_metadata: true,
              limit: SLACK_RECONCILE_LIMIT,
              ...(cursor ? { cursor } : {}),
            }),
          )
    ) as SlackConversationLookupResponse;
    const matches = findSlackConversationDeliveryParts({
      messages: asSlackConversationMessages(response),
      queueId: params.queueId,
      deliveryId: params.deliveryId,
      channelId: params.channelId,
      ...(threadTs ? { threadTs } : {}),
    });
    for (const match of matches) {
      expectedPartCount ??= match.partCount;
      const existing = deliveryParts.get(match.partIndex);
      if (
        expectedPartCount !== match.partCount ||
        (existing && existing.messageId !== match.messageId)
      ) {
        return {
          reconciliation: {
            status: "unresolved",
            error: "Slack history contains conflicting durable delivery markers",
            retryable: false,
          },
          evidence: "conflict",
        };
      }
      deliveryParts.set(match.partIndex, match);
    }
    if (expectedPartCount !== undefined && deliveryParts.size === expectedPartCount) {
      const orderedParts = Array.from({ length: expectedPartCount }, (_, index) =>
        deliveryParts.get(index),
      );
      if (orderedParts.some((part) => !part)) {
        return {
          reconciliation: {
            status: "unresolved",
            error: "Slack history contains an invalid durable delivery marker set",
            retryable: false,
          },
          evidence: "conflict",
        };
      }
      const completeParts = orderedParts as SlackDeliveryPart[];
      const reconciledThreadTs = completeParts[0]?.threadTs ?? params.threadTs;
      const platformMessageIds = completeParts.map((part) => part.messageId);
      return {
        reconciliation: {
          status: "sent",
          messageId: platformMessageIds[0],
          receipt: createSlackSendReceipt({
            platformMessageIds,
            channelId: params.channelId,
            kind: "text",
            ...(reconciledThreadTs ? { threadTs: reconciledThreadTs } : {}),
          }),
        },
        evidence: "complete",
      };
    }
    const nextCursor = normalizeOptionalString(response.response_metadata?.next_cursor);
    if (!nextCursor) {
      if (response.has_more === true) {
        break;
      }
      // Marker absence cannot prove that Slack never committed the request: a
      // delayed, deleted, or visibility-filtered message would make replay duplicate it.
      return {
        reconciliation: {
          status: "unresolved",
          error:
            deliveryParts.size > 0
              ? "Slack history contains an incomplete durable delivery marker set"
              : "Slack history contains no exact durable delivery marker",
          retryable: params.retryCount < 2,
        },
        evidence: deliveryParts.size > 0 ? "partial" : "none",
      };
    }
    cursor = nextCursor;
  }
  return {
    reconciliation: {
      status: "unresolved",
      error: "Slack unknown-send reconciliation exceeded its history page budget",
      retryable: params.retryCount < 2,
    },
    evidence: deliveryParts.size > 0 ? "partial" : "none",
  };
}

export async function reconcileSlackUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
  opts?: { client?: SlackConversationLookupClient },
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  const cfg = requireRuntimeConfig(ctx.cfg, "Slack delivery reconciliation");
  const account = resolveSlackAccount({
    cfg,
    accountId: ctx.accountId ?? undefined,
  });
  const deliveryId = createSlackDeliveryMetadataId(ctx.queueId);
  if (!deliveryId) {
    return {
      status: "unresolved",
      error: "Slack unknown-send reconciliation requires a durable delivery id",
      retryable: false,
    };
  }
  const readToken = resolveSlackOperationToken(account, "read");
  if (!readToken) {
    return {
      status: "unresolved",
      error: `Slack read token missing for account "${account.accountId}"`,
      retryable: false,
    };
  }
  const recipient = parseRecipient(ctx.to);
  const userRecipient = isSlackUserRecipient(recipient);
  const writeToken = resolveSlackOperationToken(account, "write");
  if (userRecipient && !writeToken) {
    return {
      status: "unresolved",
      error: `Slack write token missing for direct-message reconciliation on account "${account.accountId}"`,
      retryable: false,
    };
  }
  const readClient = opts?.client ?? createSlackWebClient(readToken);
  const writeClient = opts?.client ?? (writeToken ? getSlackWriteClient(writeToken) : undefined);
  const payloadReplyToId = ctx.payloads[0]?.replyToId;
  const effectiveReplyToId = Object.hasOwn(ctx, "effectiveReplyToId")
    ? normalizeOptionalString(ctx.effectiveReplyToId)
    : payloadReplyToId != null
      ? normalizeOptionalString(payloadReplyToId)
      : ctx.replyToMode === "off"
        ? undefined
        : normalizeOptionalString(ctx.replyToId);
  const threadTs = resolveSlackThreadTsValue({
    replyToId: effectiveReplyToId,
    threadId: ctx.threadId,
  });
  const searchStartedAt = ctx.platformSendStartedAt ?? ctx.enqueuedAt;
  const oldest = formatSlackTimestampFromMs(
    searchStartedAt - SLACK_RECONCILE_LOOKBACK_MS - SLACK_RECONCILE_CLOCK_SKEW_MS,
  );
  // Slack message timestamps use provider time. Bound the scan near the local
  // attempt while leaving a generous skew budget between the two clocks.
  const latest = formatSlackTimestampFromMs(searchStartedAt + SLACK_RECONCILE_CLOCK_SKEW_MS);

  try {
    const channelClient = userRecipient ? writeClient : readClient;
    const channelToken = userRecipient ? writeToken : readToken;
    if (!channelClient || !channelToken) {
      throw new Error(`Slack channel resolution token missing for account "${account.accountId}"`);
    }
    const { channelId } = await resolveChannelId(channelClient as WebClient, recipient, {
      accountId: account.accountId,
      token: channelToken,
    });
    const lookupClients = opts?.client
      ? [opts.client]
      : [readClient, ...(writeClient && writeToken !== readToken ? [writeClient] : [])];
    let lookupError: unknown;
    let bestUnresolvedScan: SlackConversationDeliveryScan | undefined;
    for (const lookupClient of lookupClients) {
      try {
        const scan = await scanSlackConversationForDelivery({
          client: lookupClient,
          channelId,
          ...(threadTs ? { threadTs } : {}),
          oldest,
          latest,
          queueId: ctx.queueId,
          deliveryId,
          retryCount: ctx.retryCount,
        });
        if (scan.reconciliation.status === "sent") {
          return scan.reconciliation;
        }
        if (
          !bestUnresolvedScan ||
          SLACK_RECONCILIATION_EVIDENCE_RANK[scan.evidence] >
            SLACK_RECONCILIATION_EVIDENCE_RANK[bestUnresolvedScan.evidence]
        ) {
          bestUnresolvedScan = scan;
        }
      } catch (err) {
        lookupError = err;
      }
    }
    if (bestUnresolvedScan) {
      return bestUnresolvedScan.reconciliation;
    }
    throw lookupError;
  } catch (err) {
    const enriched = enrichSlackWebApiError(err);
    return {
      status: "unresolved",
      error: readSlackRequestErrorMessage(enriched),
      retryable: ctx.retryCount < 3,
    };
  }
}

export async function sendMessageSlack(
  to: string,
  message: string,
  opts: SlackSendOpts,
): Promise<SlackSendResult> {
  const trimmedMessage = normalizeOptionalString(message) ?? "";
  const cfg = requireRuntimeConfig(opts.cfg, "Slack send");
  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });
  const enterpriseEventScope = resolveEnterpriseEventScope({ account, opts });
  const enterpriseDelivery = enterpriseEventScope
    ? Object.freeze({
        client: enterpriseEventScope.client,
        teamId: enterpriseEventScope.teamId,
        ...(enterpriseEventScope.uploadCompletionClient
          ? { uploadCompletionClient: enterpriseEventScope.uploadCompletionClient }
          : {}),
      })
    : undefined;
  if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
    logVerbose("slack send: suppressed NO_REPLY token before API call");
    return {
      messageId: "suppressed",
      channelId: "",
      receipt: createSlackSendReceipt({ platformMessageIds: [], kind: "unknown" }),
    };
  }
  const blocks = opts.blocks == null ? undefined : validateSlackBlocksArray(opts.blocks);
  if (!trimmedMessage && !opts.mediaUrl && !blocks) {
    throw new Error("Slack send requires text, blocks, or media");
  }
  const token = enterpriseDelivery
    ? SLACK_ENTERPRISE_LISTENER_QUEUE_CREDENTIAL
    : resolveToken({
        explicit: opts.token,
        accountId: account.accountId,
        fallbackToken: account.botToken,
        fallbackSource: account.botTokenSource,
      });
  const recipient = enterpriseDelivery ? parseEnterpriseEventRecipient(to) : parseRecipient(to);
  const queueKey = createSlackSendQueueKey({
    accountId: account.accountId,
    token,
    recipient,
    threadTs: opts.threadTs,
    ...(enterpriseDelivery ? { teamId: enterpriseDelivery.teamId } : {}),
  });
  const queuedOpts = enterpriseDelivery
    ? Object.freeze({ ...opts, client: enterpriseDelivery.client })
    : opts;
  const result = await runQueuedSlackSend(queueKey, () =>
    sendMessageSlackQueued({
      trimmedMessage,
      opts: queuedOpts,
      cfg,
      account,
      token,
      recipient,
      blocks,
      ...(enterpriseDelivery ? { enterpriseDelivery } : {}),
    }),
  );
  const threadTs = result.threadTs ?? normalizeSlackThreadTsCandidate(queuedOpts.threadTs);
  if (threadTs && result.channelId && account.accountId) {
    if (enterpriseDelivery) {
      recordSlackThreadParticipation(account.accountId, result.channelId, threadTs, {
        teamId: enterpriseDelivery.teamId,
      });
    } else {
      recordSlackThreadParticipation(account.accountId, result.channelId, threadTs);
    }
  }
  return result;
}

async function sendMessageSlackQueued(params: {
  trimmedMessage: string;
  opts: SlackSendOpts;
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveSlackAccount>;
  token: string;
  recipient: SlackRecipient;
  blocks?: (Block | KnownBlock)[];
  enterpriseDelivery?: SlackEnterpriseDelivery;
}): Promise<SlackSendResult> {
  try {
    return await sendMessageSlackQueuedInner(params);
  } catch (err) {
    throw enrichSlackWebApiError(err);
  }
}

async function sendMessageSlackQueuedInner(params: {
  trimmedMessage: string;
  opts: SlackSendOpts;
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveSlackAccount>;
  token: string;
  recipient: SlackRecipient;
  blocks?: (Block | KnownBlock)[];
  enterpriseDelivery?: SlackEnterpriseDelivery;
}): Promise<SlackSendResult> {
  const { opts, cfg, account, token, recipient, blocks, trimmedMessage, enterpriseDelivery } =
    params;
  const client = enterpriseDelivery?.client ?? opts.client ?? getSlackWriteClient(token);
  const identity = enterpriseDelivery
    ? normalizeSlackSendIdentity(opts.identity)
    : resolveSlackSendIdentity({
        accountId: account.accountId,
        explicit: opts.identity,
      });
  if (opts.replyBroadcast && opts.mediaUrl) {
    throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
  }
  const unfurl = enterpriseDelivery
    ? { unfurlMedia: account.config.unfurlMedia }
    : {
        unfurlLinks: account.config.unfurlLinks,
        unfurlMedia: account.config.unfurlMedia,
      };
  // Durable signatures bind the concrete provider channel, so user-targeted
  // sends must resolve U... to the resulting D... conversation first.
  const directUserPostChannelId = opts.deliveryQueueId
    ? undefined
    : resolveDirectUserPostChannelId({
        recipient,
        hasMedia: Boolean(opts.mediaUrl),
        ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      });
  const { channelId } = directUserPostChannelId
    ? { channelId: directUserPostChannelId }
    : await resolveChannelId(client, recipient, {
        accountId: account.accountId,
        token,
      });
  const reportDelivery = async (result: SlackSendResult) => {
    await opts.onDeliveryResult?.(result);
    return result;
  };
  if (blocks) {
    if (opts.mediaUrl) {
      throw new Error("Slack send does not support blocks with mediaUrl");
    }
    const fallbackText = truncateSlackText(
      appendSlackDataVisualizationFallbackText(
        trimmedMessage || buildSlackBlocksFallbackText(blocks),
        blocks,
      ),
      SLACK_TEXT_LIMIT,
    );
    await opts.onPlatformSendDispatch?.();
    const { response } = await postSlackMessageBestEffort({
      client,
      channelId,
      text: fallbackText,
      threadTs: opts.threadTs,
      replyBroadcast: opts.replyBroadcast,
      identity,
      blocks,
      metadata: opts.metadata,
      unfurl,
    });
    if (enterpriseDelivery && (!response.ok || !response.ts)) {
      throw new Error(
        response.ok
          ? "Slack chat.postMessage returned no message timestamp"
          : `Slack chat.postMessage failed: ${response.error ?? "unknown error"}`,
      );
    }
    const messageId = response.ts ?? "unknown";
    const deliveredChannelId = resolvePostedMessageChannelId(response, channelId);
    const deliveredThreadTs =
      resolvePostedMessageThreadTs(response) ?? normalizeSlackThreadTsCandidate(opts.threadTs);
    return await reportDelivery({
      messageId,
      channelId: deliveredChannelId,
      threadTs: deliveredThreadTs,
      receipt: createSlackSendReceipt({
        platformMessageIds: [messageId],
        channelId: deliveredChannelId,
        kind: "card",
        threadTs: deliveredThreadTs,
      }),
    });
  }
  const resolvedChunks = resolveSlackTextChunks({
    cfg,
    accountId: account.accountId,
    text: trimmedMessage,
    ...(opts.textLimit !== undefined ? { textLimit: opts.textLimit } : {}),
  });
  const mediaMaxBytes =
    opts.mediaMaxBytes ??
    (typeof account.config.mediaMaxMb === "number"
      ? account.config.mediaMaxMb * 1024 * 1024
      : undefined);

  const sentMessageIds: string[] = [];
  let lastMessageId = "";
  let deliveredChannelId = channelId;
  let canonicalDeliveredThreadTs: string | undefined;
  let chunksToPost: string[];
  if (opts.mediaUrl) {
    if (enterpriseDelivery && !enterpriseDelivery.uploadCompletionClient) {
      throw new Error("missing_enterprise_slack_upload_completion_client");
    }
    const [firstChunk, ...rest] = resolvedChunks;
    lastMessageId = await uploadSlackFile({
      client,
      ...(enterpriseDelivery?.uploadCompletionClient
        ? { completionClient: enterpriseDelivery.uploadCompletionClient }
        : {}),
      channelId,
      mediaUrl: opts.mediaUrl,
      mediaAccess: opts.mediaAccess,
      uploadFileName: opts.uploadFileName,
      uploadTitle: opts.uploadTitle,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
      caption: firstChunk,
      threadTs: opts.threadTs,
      maxBytes: mediaMaxBytes,
      onPlatformSendDispatch: opts.onPlatformSendDispatch,
      ...(enterpriseDelivery ? { auditContext: "slack-enterprise-immediate-upload" } : {}),
    });
    sentMessageIds.push(lastMessageId);
    await reportDelivery({
      messageId: lastMessageId,
      channelId,
      threadTs: normalizeSlackThreadTsCandidate(opts.threadTs),
      receipt: createSlackSendReceipt({
        platformMessageIds: [lastMessageId],
        channelId,
        kind: "media",
        threadTs: normalizeSlackThreadTsCandidate(opts.threadTs),
      }),
    });
    chunksToPost = rest;
  } else {
    chunksToPost = resolvedChunks.length ? resolvedChunks : [""];
  }

  let sendIdentity = identity;
  for (const [partIndex, chunk] of chunksToPost.entries()) {
    const baseMetadata = sentMessageIds.length === 0 ? opts.metadata : undefined;
    // Every post carries its index/count so reconciliation proves the complete
    // logical text send and never mistakes a partial chunk fanout for success.
    const metadata = opts.mediaUrl
      ? baseMetadata
      : withSlackDeliveryMetadata(baseMetadata, {
          queueId: opts.deliveryQueueId,
          channelId,
          threadTs: opts.threadTs,
          partIndex,
          partCount: chunksToPost.length,
        });
    if (partIndex === 0 && !opts.mediaUrl) {
      await opts.onPlatformSendDispatch?.();
    }
    const posted = await postSlackMessageBestEffort({
      client,
      channelId,
      text: chunk,
      threadTs: opts.threadTs,
      replyBroadcast: sentMessageIds.length === 0 ? opts.replyBroadcast : undefined,
      identity: sendIdentity,
      metadata,
      unfurl,
    });
    const response = posted.response;
    if (enterpriseDelivery && (!response.ok || !response.ts)) {
      throw new Error(
        response.ok
          ? "Slack chat.postMessage returned no message timestamp"
          : `Slack chat.postMessage failed: ${response.error ?? "unknown error"}`,
      );
    }
    sendIdentity = posted.identity;
    lastMessageId = response.ts ?? lastMessageId;
    deliveredChannelId = resolvePostedMessageChannelId(response, deliveredChannelId);
    canonicalDeliveredThreadTs ??= resolvePostedMessageThreadTs(response);
    if (response.ts) {
      sentMessageIds.push(response.ts);
      await reportDelivery({
        messageId: response.ts,
        channelId: deliveredChannelId,
        threadTs:
          resolvePostedMessageThreadTs(response) ?? normalizeSlackThreadTsCandidate(opts.threadTs),
        receipt: createSlackSendReceipt({
          platformMessageIds: [response.ts],
          channelId: deliveredChannelId,
          kind: "text",
          threadTs:
            resolvePostedMessageThreadTs(response) ??
            normalizeSlackThreadTsCandidate(opts.threadTs),
        }),
      });
    }
  }

  const messageId = lastMessageId || "unknown";
  const deliveredThreadTs =
    canonicalDeliveredThreadTs ?? normalizeSlackThreadTsCandidate(opts.threadTs);
  return {
    messageId,
    channelId: deliveredChannelId,
    threadTs: deliveredThreadTs,
    receipt: createSlackSendReceipt({
      platformMessageIds: sentMessageIds.length ? sentMessageIds : [messageId],
      channelId: deliveredChannelId,
      kind: opts.mediaUrl ? "media" : "text",
      threadTs: deliveredThreadTs,
    }),
  };
}
