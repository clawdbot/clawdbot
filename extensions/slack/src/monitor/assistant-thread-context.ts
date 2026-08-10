// Slack plugin module owns Assistant thread context metadata and caching.
import type { SlackEventScope } from "./event-scope.js";

export type SlackAssistantThreadContext = {
  assistantChannelId: string;
  threadTs: string;
  userId?: string;
  channelId?: string;
  teamId?: string;
  enterpriseId?: string | null;
  updatedAt: number;
};

const SLACK_ASSISTANT_THREAD_CONTEXT_METADATA_EVENT = "assistant_thread_context";
const SLACK_ASSISTANT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_ASSISTANT_CONTEXT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export function buildSlackAssistantThreadMetadata(
  context: Omit<SlackAssistantThreadContext, "updatedAt">,
) {
  const eventPayload: Record<string, string> = {};
  if (context.channelId) {
    eventPayload.channel_id = context.channelId;
  }
  if (context.teamId) {
    eventPayload.team_id = context.teamId;
  }
  if (context.enterpriseId) {
    eventPayload.enterprise_id = context.enterpriseId;
  }
  return {
    event_type: SLACK_ASSISTANT_THREAD_CONTEXT_METADATA_EVENT,
    event_payload: eventPayload,
  };
}

export function parseSlackAssistantThreadMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.event_type !== SLACK_ASSISTANT_THREAD_CONTEXT_METADATA_EVENT) {
    return undefined;
  }
  const payload = metadata.event_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return {
    channelId: readStringField(record, "channel_id"),
    teamId: readStringField(record, "team_id"),
    enterpriseId: readStringField(record, "enterprise_id"),
  };
}

export function createSlackAssistantThreadContextStore(params: { accountId: string }) {
  const contexts = new Map<string, SlackAssistantThreadContext>();
  let lastCleanupAt = Date.now();

  const get = (
    channelId: string | undefined,
    threadTs: string | undefined,
    eventScope?: SlackEventScope,
  ) => {
    if (!channelId || !threadTs) {
      return undefined;
    }
    const key = buildContextKey(params.accountId, channelId, threadTs, eventScope);
    const entry = contexts.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.updatedAt > SLACK_ASSISTANT_CONTEXT_TTL_MS) {
      contexts.delete(key);
      return undefined;
    }
    return entry;
  };

  const save = (
    context: Omit<SlackAssistantThreadContext, "updatedAt">,
    eventScope?: SlackEventScope,
  ) => {
    const now = Date.now();
    if (now - lastCleanupAt >= SLACK_ASSISTANT_CONTEXT_CLEANUP_INTERVAL_MS) {
      lastCleanupAt = now;
      const cutoff = now - SLACK_ASSISTANT_CONTEXT_TTL_MS;
      for (const [key, entry] of contexts) {
        if (entry.updatedAt < cutoff) {
          contexts.delete(key);
        }
      }
    }
    contexts.set(
      buildContextKey(params.accountId, context.assistantChannelId, context.threadTs, eventScope),
      { ...context, updatedAt: now },
    );
  };

  return { get, save };
}

function readStringField(record: Record<string, unknown>, key: string) {
  const raw = record[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function buildContextKey(
  accountId: string,
  channelId: string,
  threadTs: string,
  eventScope?: SlackEventScope,
) {
  const key = `${channelId}:${threadTs}`;
  return eventScope ? `${accountId}:${eventScope.teamId}:${key}` : key;
}
