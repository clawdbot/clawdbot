import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

const CHAT_RUN_PROGRESS_MAX_EVENTS = 50;
const CHAT_RUN_PROGRESS_MAX_BYTES = 128 * 1024;
const CHAT_RUN_PROGRESS_MAX_EVENT_BYTES = 64 * 1024;
const CHAT_RUN_PROGRESS_MAX_REVIEWS_PER_TOOL = 16;

export type ChatRunProgressSnapshot = {
  events: AgentEventPayload[];
  byteLength: number;
  lastSeq: number;
};

export function updateChatRunProgressSnapshot(
  snapshot: ChatRunProgressSnapshot | undefined,
  event: AgentEventPayload,
): ChatRunProgressSnapshot | undefined {
  const data = event.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId.trim() : "";
  const review = asNullableRecord(data.review) ?? undefined;
  const reviewId = typeof review?.id === "string" ? review.id.trim() : "";
  const preambleItemId =
    typeof data.itemId === "string" && data.itemId.trim()
      ? data.itemId.trim()
      : typeof data.id === "string" && data.id.trim()
        ? data.id.trim()
        : "";
  const isTool =
    event.stream === "tool" &&
    Boolean(toolCallId) &&
    ["start", "input_delta", "update", "review", "result"].includes(phase) &&
    (phase !== "review" || Boolean(reviewId));
  const isPreamble = event.stream === "item" && data.kind === "preamble";
  const isNotice = event.stream === "notice" && phase === "warning";
  const guardianTargetItemId =
    typeof data.targetItemId === "string" ? data.targetItemId.trim() : "";
  const isGuardian = event.stream === "codex_app_server.guardian";
  const isStandaloneGuardian =
    isGuardian &&
    (phase === "warning" ||
      phase === "strict_review_required" ||
      ((phase === "started" || phase === "completed") && !guardianTargetItemId));
  const resolvesStrictReview =
    isGuardian &&
    phase === "completed" &&
    Boolean(guardianTargetItemId) &&
    snapshot?.events.some(
      (candidate) =>
        candidate.stream === event.stream &&
        candidate.data.phase === "strict_review_required" &&
        candidate.data.reviewId === data.reviewId,
    );
  if (!isTool && !isPreamble && !isStandaloneGuardian && !isNotice && !resolvesStrictReview) {
    return snapshot;
  }

  const next = snapshot ?? { events: [], byteLength: 0, lastSeq: 0 };
  // Agent events are run-sequenced. Reject delayed duplicates so reconnect
  // state cannot resurrect a tool that a newer result already completed.
  if (event.seq <= next.lastSeq) {
    return next;
  }
  next.lastSeq = event.seq;
  const matchesPreamble = (candidate: AgentEventPayload) =>
    candidate.stream === "item" &&
    candidate.data?.kind === "preamble" &&
    (candidate.data.itemId ?? "") === preambleItemId;
  const previousPreamble = preambleItemId ? next.events.find(matchesPreamble) : undefined;

  const removeWhere = (predicate: (candidate: AgentEventPayload) => boolean) => {
    next.events = next.events.filter((candidate) => !predicate(candidate));
    next.byteLength = next.events.reduce((total, candidate) => total + jsonUtf8Bytes(candidate), 0);
  };

  if (isTool) {
    removeWhere((candidate) => {
      if (candidate.stream !== "tool" || candidate.data?.toolCallId !== toolCallId) {
        return false;
      }
      if (phase === "start") {
        return true;
      }
      if (phase === "result") {
        return candidate.data?.phase === "result";
      }
      if (phase !== "review" || candidate.data?.phase !== "review") {
        return candidate.data?.phase === phase;
      }
      // One command can own parallel reviews; replace only the matching
      // review ID so reconnect restores every still-relevant decision.
      return asNullableRecord(candidate.data.review)?.id === reviewId;
    });
  } else if (isPreamble) {
    const progressText = typeof data.progressText === "string" ? data.progressText.trim() : "";
    removeWhere(matchesPreamble);
    if (!progressText) {
      return next;
    }
  } else if ((isStandaloneGuardian || resolvesStrictReview) && typeof data.reviewId === "string") {
    removeWhere(
      (candidate) =>
        candidate.stream === event.stream && candidate.data?.reviewId === data.reviewId,
    );
    if (resolvesStrictReview) {
      return next;
    }
  }

  const storedData: Record<string, unknown> = isTool
    ? {
        phase,
        name: typeof data.name === "string" ? data.name : undefined,
        toolCallId,
        args: phase === "start" ? data.args : undefined,
        partialResult: phase === "update" ? data.partialResult : undefined,
        diff: phase === "input_delta" ? data.diff : undefined,
        review: phase === "review" ? data.review : undefined,
        approvalReviewOutcome:
          phase === "review" || phase === "result" ? data.approvalReviewOutcome : undefined,
        isError: phase === "result" ? data.isError : undefined,
        result: phase === "result" ? data.result : undefined,
      }
    : isPreamble
      ? {
          kind: "preamble",
          itemId: preambleItemId || undefined,
          progressText: data.progressText,
        }
      : { ...data };
  for (const key of Object.keys(storedData)) {
    if (storedData[key] === undefined) {
      delete storedData[key];
    }
  }
  let storedEvent: AgentEventPayload = {
    runId: event.runId,
    seq: event.seq,
    stream: event.stream,
    // Keep first-seen time so reload cannot move updated commentary across a later steer.
    ts: previousPreamble?.ts ?? event.ts,
    data: storedData,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
  };
  let eventBytes = jsonUtf8Bytes(storedEvent);
  if (eventBytes > CHAT_RUN_PROGRESS_MAX_EVENT_BYTES && isTool) {
    delete storedData.args;
    delete storedData.partialResult;
    delete storedData.diff;
    delete storedData.result;
    storedEvent = { ...storedEvent, data: storedData };
    eventBytes = jsonUtf8Bytes(storedEvent);
  }
  if (eventBytes > CHAT_RUN_PROGRESS_MAX_EVENT_BYTES) {
    return next;
  }
  next.events.push(storedEvent);
  next.byteLength += eventBytes;
  if (phase === "review") {
    const reviews = next.events.filter(
      (candidate) =>
        candidate.stream === "tool" &&
        candidate.data?.toolCallId === toolCallId &&
        candidate.data?.phase === "review",
    );
    const overflow = reviews.length - CHAT_RUN_PROGRESS_MAX_REVIEWS_PER_TOOL;
    if (overflow > 0) {
      const evicted = new Set(reviews.slice(0, overflow));
      removeWhere((candidate) => evicted.has(candidate));
    }
  }
  while (
    next.events.length > CHAT_RUN_PROGRESS_MAX_EVENTS ||
    next.byteLength > CHAT_RUN_PROGRESS_MAX_BYTES
  ) {
    const oldest = next.events[0];
    if (!oldest) {
      break;
    }
    const oldestToolCallId =
      oldest.stream === "tool" && typeof oldest.data?.toolCallId === "string"
        ? oldest.data.toolCallId
        : "";
    // Review/update events depend on their start. Evict the complete owner group.
    removeWhere((candidate) =>
      oldestToolCallId
        ? candidate.stream === "tool" && candidate.data?.toolCallId === oldestToolCallId
        : candidate === oldest,
    );
  }
  return next;
}
