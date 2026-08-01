// QA Lab Slack capture reads transient native task chunks from the shared debug capture store.
import { setTimeout as sleep } from "node:timers/promises";
import type { SlackQaNativeTaskUpdate } from "./slack-live.contracts.js";

const SLACK_QA_CAPTURE_EVENT_LIMIT = 5_000;
const SLACK_QA_CAPTURE_SETTLE_TIMEOUT_MS = 5_000;
const SLACK_QA_TASK_TEXT_MAX_CHARS = 2_048;
const SLACK_QA_STREAM_METHODS = new Set([
  "chat.appendStream",
  "chat.startStream",
  "chat.stopStream",
]);

type SlackQaCaptureStore = {
  getSessionEvents(sessionId: string, limit?: number): Array<Record<string, unknown>>;
  readBlob(blobId: string): string | null;
};

function readSlackQaCapturePayload(
  store: SlackQaCaptureStore,
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

function isSuccessfulSlackCaptureResponse(
  store: SlackQaCaptureStore,
  event: Record<string, unknown>,
) {
  if (event.kind !== "response" || event.status !== 200) {
    return false;
  }
  const payload = readSlackQaCapturePayload(store, event);
  if (!payload) {
    return false;
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}

function parseSlackQaNativeTaskUpdates(
  method: SlackQaNativeTaskUpdate["method"],
  payload: string,
): SlackQaNativeTaskUpdate[] {
  const chunksValue = new URLSearchParams(payload).get("chunks");
  if (!chunksValue) {
    return [];
  }
  let chunks: unknown;
  try {
    chunks = JSON.parse(chunksValue) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(chunks)) {
    return [];
  }
  return chunks.flatMap((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      return [];
    }
    const record = chunk as Record<string, unknown>;
    if (
      record.type !== "task_update" ||
      typeof record.id !== "string" ||
      typeof record.title !== "string"
    ) {
      return [];
    }
    const status = typeof record.status === "string" ? record.status : undefined;
    return [
      {
        id: record.id.slice(0, SLACK_QA_TASK_TEXT_MAX_CHARS),
        method,
        ...(status ? { status: status.slice(0, SLACK_QA_TASK_TEXT_MAX_CHARS) } : {}),
        title: record.title.slice(0, SLACK_QA_TASK_TEXT_MAX_CHARS),
      },
    ];
  });
}

function isSlackQaStreamRequest(event: Record<string, unknown>) {
  if (event.kind !== "request" || event.method !== "POST" || typeof event.path !== "string") {
    return false;
  }
  return (
    event.path.startsWith("/api/") && SLACK_QA_STREAM_METHODS.has(event.path.slice("/api/".length))
  );
}

function readSlackQaCaptureEvents(params: { sessionId: string; store: SlackQaCaptureStore }) {
  return params.store.getSessionEvents(params.sessionId, SLACK_QA_CAPTURE_EVENT_LIMIT);
}

export function getSlackQaNativeTaskUpdateCursor(params: {
  sessionId: string;
  store: SlackQaCaptureStore;
}): number {
  return readSlackQaCaptureEvents(params).reduce(
    (cursor, event) =>
      isSlackQaStreamRequest(event) && typeof event.id === "number"
        ? Math.max(cursor, event.id)
        : cursor,
    0,
  );
}

function collectSlackQaNativeTaskUpdates(params: {
  afterRequestEventId: number;
  events: Array<Record<string, unknown>>;
  store: SlackQaCaptureStore;
}) {
  const requests = params.events.filter(
    (event) =>
      isSlackQaStreamRequest(event) &&
      typeof event.id === "number" &&
      event.id > params.afterRequestEventId,
  );
  const responseFlowIds = new Set(
    params.events
      .filter((event) => event.kind === "response")
      .map((event) => event.flowId)
      .filter((flowId): flowId is string => typeof flowId === "string"),
  );
  const successfulFlowIds = new Set(
    params.events
      .filter((event) => isSuccessfulSlackCaptureResponse(params.store, event))
      .map((event) => event.flowId)
      .filter((flowId): flowId is string => typeof flowId === "string"),
  );
  const updates = requests.toReversed().flatMap((event) => {
    if (
      typeof event.flowId !== "string" ||
      !successfulFlowIds.has(event.flowId) ||
      typeof event.path !== "string"
    ) {
      return [];
    }
    const method = event.path.startsWith("/api/") ? event.path.slice("/api/".length) : "";
    if (!SLACK_QA_STREAM_METHODS.has(method)) {
      return [];
    }
    const payload = readSlackQaCapturePayload(params.store, event);
    return payload
      ? parseSlackQaNativeTaskUpdates(method as SlackQaNativeTaskUpdate["method"], payload)
      : [];
  });
  return {
    settled: requests.every(
      (event) => typeof event.flowId === "string" && responseFlowIds.has(event.flowId),
    ),
    updates,
  };
}

export async function readSlackQaNativeTaskUpdates(params: {
  afterRequestEventId: number;
  sessionId: string;
  settleTimeoutMs?: number;
  store: SlackQaCaptureStore;
}): Promise<SlackQaNativeTaskUpdate[]> {
  const timeoutMs = params.settleTimeoutMs ?? SLACK_QA_CAPTURE_SETTLE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = collectSlackQaNativeTaskUpdates({
      afterRequestEventId: params.afterRequestEventId,
      events: readSlackQaCaptureEvents(params),
      store: params.store,
    });
    if (result.settled || Date.now() >= deadline) {
      return result.updates;
    }
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
