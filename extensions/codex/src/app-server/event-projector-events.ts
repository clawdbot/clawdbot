import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asFiniteNumber,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isNonSuccessItemStatus,
  itemKind,
  itemName,
  itemStatus,
  itemTitle,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import {
  itemMeta,
  isCommandBearingToolItem,
  itemToolArgs,
  itemToolResult,
  shouldSuppressChannelProgressForItem,
} from "./event-projector-tool-items.js";
import {
  CodexToolProgressProjection,
  shouldEmitTranscriptToolProgress,
} from "./event-projector-tool-progress.js";
import { CodexToolTranscriptProjection } from "./event-projector-tool-transcript.js";
import { readHookOutputEntries, readNullableString } from "./event-projector-values.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];

type NormalizedToolItemProjection = {
  name: string;
  status: ReturnType<typeof itemStatus>;
  args: Record<string, unknown> | undefined;
  meta: string | undefined;
  event: AgentEvent | undefined;
};

function guardianActionCommand(action: JsonObject | undefined): string | undefined {
  if (!action) {
    return undefined;
  }
  const directLabel =
    readString(action, "command") ??
    readString(action, "target") ??
    readString(action, "toolTitle") ??
    readString(action, "reason");
  if (directLabel) {
    return directLabel;
  }
  const server = readString(action, "connectorName") ?? readString(action, "server");
  const tool = readString(action, "toolName");
  if (server && tool) {
    return `${server}/${tool}`;
  }
  const argv = Array.isArray(action.argv)
    ? action.argv.filter((value): value is string => typeof value === "string")
    : [];
  return argv.length > 0 ? argv.join(" ") : readString(action, "program");
}

function normalizeApprovalReviewStatus(status: string | undefined): string | undefined {
  return status === "inProgress" ? "in_progress" : status === "timedOut" ? "timed_out" : status;
}

const GUARDIAN_TIMEOUT_WARNING =
  "Automatic approval review timed out while evaluating the requested approval.";

export function projectNormalizedToolItem(params: {
  phase: "start" | "result";
  item: CodexThreadItem | undefined;
  detailMode?: ToolProgressDetailMode;
}): NormalizedToolItemProjection | undefined {
  const { item } = params;
  if (!item || !shouldSynthesizeToolProgressForItem(item)) {
    return undefined;
  }
  const name = itemName(item);
  if (!name) {
    return undefined;
  }
  const status = params.phase === "result" ? itemStatus(item) : "running";
  const args = itemToolArgs(item);
  const commandBearing = isCommandBearingToolItem(item, args);
  const meta = itemMeta(item, params.detailMode);
  const event = shouldEmitTranscriptToolProgress(name, args)
    ? {
        stream: "tool",
        data: {
          phase: params.phase,
          name,
          itemId: item.id,
          toolCallId: item.id,
          ...(meta ? { meta } : {}),
          ...(commandBearing ? { commandBearing: true as const } : {}),
          ...(params.phase === "start" && args ? { args } : {}),
          ...(params.phase === "result"
            ? {
                status,
                isError: isNonSuccessItemStatus(status),
                ...itemToolResult(item),
              }
            : {}),
        },
      }
    : undefined;
  return { name, status, args, meta, event };
}

export class CodexEventProjection {
  private reviewCount = 0;
  private pendingGuardianWarning: string | undefined;
  private activeGuardianReview:
    | {
        reviewId?: string;
        targetItemId?: string | null;
        command?: string;
        threadId: string;
        turnId: string;
      }
    | undefined;

  constructor(
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
    private readonly toolProgress: CodexToolProgressProjection,
    private readonly toolTranscript: CodexToolTranscriptProjection,
    private readonly onNativeToolResultRecorded?: () => void | Promise<void>,
  ) {}

  get guardianReviewCount(): number {
    return this.reviewCount;
  }

  handleGuardianReview(method: string, params: JsonObject): void {
    this.reviewCount += 1;
    const review = isJsonObject(params.review) ? params.review : undefined;
    const action = isJsonObject(params.action) ? params.action : undefined;
    const reviewId = readString(params, "reviewId");
    const targetItemId = readNullableString(params, "targetItemId");
    const command = guardianActionCommand(action);
    const reviewStatus = review ? readString(review, "status") : undefined;
    const status = normalizeApprovalReviewStatus(reviewStatus);
    const riskLevel = review ? readString(review, "riskLevel") : undefined;
    const userAuthorization = review ? readString(review, "userAuthorization") : undefined;
    const rationale = review ? readNullableString(review, "rationale") : undefined;
    // Codex emits the routine warning immediately before its structured terminal fact.
    // Exact byte equality consumes only that duplicate; every other warning is flushed.
    const expectedWarning =
      status === "timed_out"
        ? GUARDIAN_TIMEOUT_WARNING
        : rationale &&
            riskLevel &&
            userAuthorization &&
            (status === "approved" || status === "denied")
          ? `Automatic approval review ${status} (risk: ${riskLevel}, authorization: ${userAuthorization}): ${rationale}`
          : undefined;
    const warningMatchesReview =
      Boolean(targetItemId) && Boolean(reviewId) && this.pendingGuardianWarning === expectedWarning;
    if (warningMatchesReview) {
      this.pendingGuardianWarning = undefined;
    } else {
      this.flushPendingGuardianWarning();
    }
    const threadId = readString(params, "threadId") ?? this.threadId;
    const turnId = readString(params, "turnId") ?? this.turnId;
    if (method.endsWith("/started")) {
      this.activeGuardianReview = { reviewId, targetItemId, command, threadId, turnId };
    }
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        method,
        phase: method.endsWith("/started") ? "started" : "completed",
        threadId,
        turnId,
        reviewId,
        targetItemId,
        decisionSource: readString(params, "decisionSource"),
        status: reviewStatus,
        riskLevel,
        userAuthorization,
        rationale,
        actionType: action ? readString(action, "type") : undefined,
        command,
      },
    });
    if (reviewId && targetItemId && status) {
      const approvalReview: JsonObject = {
        id: reviewId,
        label: "Guardian",
        status,
        ...(riskLevel ? { riskLevel } : {}),
        ...(userAuthorization ? { userAuthorization } : {}),
        ...(rationale ? { rationale } : {}),
      };
      const approvalReviewOutcome = this.toolTranscript.recordToolApprovalReview(
        targetItemId,
        reviewId,
        status,
        approvalReview,
      );
      this.emitAgentEvent({
        stream: "tool",
        data: {
          phase: "review",
          toolCallId: targetItemId,
          hideFromChannelProgress: true,
          approvalReviewOutcome,
          review: approvalReview,
        },
      });
    }
    if (method.endsWith("/completed") && this.activeGuardianReview?.reviewId === reviewId) {
      this.activeGuardianReview = undefined;
    }
  }

  handleGuardianWarning(params: JsonObject): void {
    this.flushPendingGuardianWarning();
    const message = readString(params, "message");
    if (message) {
      this.pendingGuardianWarning = message;
      return;
    }
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: { phase: "warning", message },
    });
  }

  handleWarning(params: JsonObject): void {
    const summary = readString(params, "summary") ?? readString(params, "message");
    const details = readString(params, "details");
    const message = [summary, details].filter(Boolean).join("\n");
    if (message) {
      this.emitAgentEvent({ stream: "notice", data: { phase: "warning", message } });
    }
  }

  handleModelRerouted(params: JsonObject): void {
    const fromModel = readString(params, "fromModel");
    const toModel = readString(params, "toModel");
    const reason = readString(params, "reason");
    if (fromModel && toModel && fromModel !== toModel) {
      this.emitAgentEvent({
        stream: "fallback",
        data: { fromModel, toModel, ...(reason ? { reason } : {}) },
      });
    }
  }

  flushPendingGuardianWarning(): void {
    const pending = this.pendingGuardianWarning;
    if (!pending) {
      return;
    }
    this.pendingGuardianWarning = undefined;
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: { phase: "warning", message: pending },
    });
  }

  handleStrictReviewRequired(params: JsonObject): void {
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        method: "autoApprovalReview/strictReviewRequired",
        phase: "strict_review_required",
        threadId:
          readString(params, "threadId") ?? this.activeGuardianReview?.threadId ?? this.threadId,
        turnId: readString(params, "turnId") ?? this.activeGuardianReview?.turnId ?? this.turnId,
        reviewId: this.activeGuardianReview?.reviewId,
        targetItemId: this.activeGuardianReview?.targetItemId,
        command: this.activeGuardianReview?.command,
        startedAtMs: asFiniteNumber(params.startedAtMs),
      },
    });
  }

  handleHook(method: string, params: JsonObject): void {
    const run = isJsonObject(params.run) ? params.run : undefined;
    if (!run) {
      return;
    }
    const durationMs = asFiniteNumber(run.durationMs);
    const entries = readHookOutputEntries(run.entries);
    const hookTurnId = readNullableString(params, "turnId");
    this.emitAgentEvent({
      stream: "codex_app_server.hook",
      data: {
        phase: method === "hook/started" ? "started" : "completed",
        threadId: this.threadId,
        turnId: hookTurnId === undefined ? this.turnId : hookTurnId,
        hookRunId: readString(run, "id"),
        eventName: readString(run, "eventName"),
        handlerType: readString(run, "handlerType"),
        executionMode: readString(run, "executionMode"),
        scope: readString(run, "scope"),
        source: readString(run, "source"),
        sourcePath: readString(run, "sourcePath"),
        status: readString(run, "status"),
        statusMessage: readNullableString(run, "statusMessage"),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(entries.length > 0 ? { entries } : {}),
      },
    });
  }

  emitStandardItemEvent(params: {
    phase: "start" | "end";
    item: CodexThreadItem | undefined;
  }): void {
    const { item } = params;
    if (!item) {
      return;
    }
    const kind = itemKind(item);
    if (!kind) {
      return;
    }
    const name = itemName(item);
    const args = itemToolArgs(item);
    const commandBearing = isCommandBearingToolItem(item, args);
    const meta = itemMeta(item, this.toolProgress.toolProgressDetailMode());
    const suppressChannelProgress = shouldSuppressChannelProgressForItem(item);
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: item.id,
        phase: params.phase,
        kind,
        title: itemTitle(item),
        status: params.phase === "start" ? "running" : itemStatus(item),
        ...(name ? { name } : {}),
        ...(meta ? { meta } : {}),
        ...(commandBearing ? { commandBearing: true } : {}),
        ...(suppressChannelProgress ? { suppressChannelProgress: true } : {}),
      },
    });
  }

  async emitNormalizedToolItemEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem | undefined;
  }): Promise<void> {
    const projection = projectNormalizedToolItem({
      ...params,
      detailMode: this.toolProgress.toolProgressDetailMode(),
    });
    if (!projection || !params.item) {
      return;
    }
    const { item } = params;
    const { name, status, args, meta, event } = projection;
    const approvalReviewOutcome =
      params.phase === "result"
        ? this.toolTranscript.finalizeToolApprovalReviews(item.id)
        : undefined;
    if (event && approvalReviewOutcome) {
      event.data.approvalReviewOutcome = approvalReviewOutcome;
    }
    this.toolTranscript.recordTrajectoryEvent({ phase: params.phase, item, name, args, status });
    if (params.phase === "result") {
      this.toolProgress.recordNativeToolError({ item, name, meta, status });
    }
    if (!event) {
      if (params.phase === "result") {
        this.toolTranscript.emitAfterToolCallObservation(item);
        await this.onNativeToolResultRecorded?.();
      }
      return;
    }
    this.emitAgentEvent(event);
    if (params.phase === "result") {
      this.toolTranscript.emitAfterToolCallObservation(item);
      await this.onNativeToolResultRecorded?.();
    }
  }
}
