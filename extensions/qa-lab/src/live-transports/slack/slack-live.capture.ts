// QA Lab Slack capture preserves transient message writes from the shared debug capture store.
import { setTimeout as sleep } from "node:timers/promises";
import type { DebugProxyCaptureReader } from "openclaw/plugin-sdk/proxy-capture";
import type { SlackObservedMessage } from "./slack-live.contracts.js";
import { collectSlackBlockText } from "./slack-live.observations.js";

const SLACK_QA_CAPTURE_EVENT_LIMIT = 5_000;
const SLACK_QA_CAPTURE_SETTLE_TIMEOUT_MS = 5_000;
const SLACK_QA_MESSAGE_TEXT_MAX_CHARS = 2_048;
const SLACK_QA_BLOCK_TEXT_MAX_ITEMS = 64;
const SLACK_QA_MESSAGE_WRITE_METHODS = new Set(["chat.postMessage", "chat.update"]);

function readSlackQaCapturePayload(
  store: DebugProxyCaptureReader,
  event: Record<string, unknown>,
): string | undefined {
  const blobId = typeof event.dataBlobId === "string" ? event.dataBlobId : undefined;
  if (blobId) {
    const payload = store.readBlob(blobId);
    if (payload !== null) {
      return payload;
    }
  }
  return typeof event.dataText === "string" ? event.dataText : undefined;
}

function parseSlackQaCaptureObject(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // @slack/web-api serializes ordinary method arguments as URL-encoded form data.
  }
  return Object.fromEntries(new URLSearchParams(payload));
}

function parseSuccessfulSlackCaptureResponse(
  store: DebugProxyCaptureReader,
  event: Record<string, unknown>,
) {
  if (event.kind !== "response" || event.status !== 200) {
    return undefined;
  }
  const payload = readSlackQaCapturePayload(store, event);
  if (!payload) {
    return undefined;
  }
  const parsed = parseSlackQaCaptureObject(payload);
  return parsed?.ok === true ? parsed : undefined;
}

function readSlackQaMethod(event: Record<string, unknown>) {
  if (
    event.kind !== "request" ||
    event.method !== "POST" ||
    event.host !== "slack.com" ||
    typeof event.path !== "string" ||
    !event.path.startsWith("/api/")
  ) {
    return undefined;
  }
  return event.path.slice("/api/".length);
}

function isSlackQaMessageWriteRequest(event: Record<string, unknown>) {
  const method = readSlackQaMethod(event);
  return method !== undefined && SLACK_QA_MESSAGE_WRITE_METHODS.has(method);
}

function readSlackQaCaptureEvents(params: { sessionId: string; store: DebugProxyCaptureReader }) {
  return params.store.getSessionEvents(params.sessionId, SLACK_QA_CAPTURE_EVENT_LIMIT);
}

export function getSlackQaMessageWriteCursor(params: {
  sessionId: string;
  store: DebugProxyCaptureReader;
}): number {
  return readSlackQaCaptureEvents(params).reduce(
    (cursor, event) =>
      isSlackQaMessageWriteRequest(event) && typeof event.id === "number"
        ? Math.max(cursor, event.id)
        : cursor,
    0,
  );
}

function parseSlackQaBlocks(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function truncateSlackQaText(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, SLACK_QA_MESSAGE_TEXT_MAX_CHARS) : undefined;
}

function parseSlackQaMessageWrite(params: {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  store: DebugProxyCaptureReader;
}): SlackObservedMessage | undefined {
  const payload = readSlackQaCapturePayload(params.store, params.request);
  const request = payload ? parseSlackQaCaptureObject(payload) : undefined;
  const channelId = truncateSlackQaText(params.response.channel ?? request?.channel);
  const ts = truncateSlackQaText(params.response.ts ?? request?.ts);
  if (!request || !channelId || !ts) {
    return undefined;
  }
  const blocks = parseSlackQaBlocks(request.blocks);
  const blockText = collectSlackBlockText(blocks)
    .slice(0, SLACK_QA_BLOCK_TEXT_MAX_ITEMS)
    .map((text) => text.slice(0, SLACK_QA_MESSAGE_TEXT_MAX_CHARS));
  return {
    channelId,
    text: truncateSlackQaText(request.text) ?? "",
    ts,
    ...(blockText.length > 0 ? { blockText } : {}),
    ...(typeof request.thread_ts === "string"
      ? { threadTs: request.thread_ts.slice(0, SLACK_QA_MESSAGE_TEXT_MAX_CHARS) }
      : {}),
  };
}

function collectSlackQaMessageWrites(params: {
  afterRequestEventId: number;
  events: Array<Record<string, unknown>>;
  store: DebugProxyCaptureReader;
}) {
  const requests = params.events.filter(
    (event) =>
      isSlackQaMessageWriteRequest(event) &&
      typeof event.id === "number" &&
      event.id > params.afterRequestEventId,
  );
  const responsesByFlowId = new Map<string, Record<string, unknown>>();
  const settledFlowIds = new Set<string>();
  for (const event of params.events) {
    if (event.kind !== "response" || typeof event.flowId !== "string") {
      continue;
    }
    settledFlowIds.add(event.flowId);
    const response = parseSuccessfulSlackCaptureResponse(params.store, event);
    if (response) {
      responsesByFlowId.set(event.flowId, response);
    }
  }
  const messages = requests.toReversed().flatMap((request) => {
    if (typeof request.flowId !== "string") {
      return [];
    }
    const response = responsesByFlowId.get(request.flowId);
    if (!response) {
      return [];
    }
    const message = parseSlackQaMessageWrite({ request, response, store: params.store });
    return message ? [message] : [];
  });
  return {
    settled: requests.every(
      (request) => typeof request.flowId === "string" && settledFlowIds.has(request.flowId),
    ),
    messages,
  };
}

export async function readSlackQaMessageWrites(params: {
  afterRequestEventId: number;
  sessionId: string;
  settleTimeoutMs?: number;
  store: DebugProxyCaptureReader;
}): Promise<SlackObservedMessage[]> {
  const timeoutMs = params.settleTimeoutMs ?? SLACK_QA_CAPTURE_SETTLE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = collectSlackQaMessageWrites({
      afterRequestEventId: params.afterRequestEventId,
      events: readSlackQaCaptureEvents(params),
      store: params.store,
    });
    if (result.settled || Date.now() >= deadline) {
      return result.messages;
    }
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
