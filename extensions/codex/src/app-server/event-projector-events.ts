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
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        method,
        phase: method.endsWith("/started") ? "started" : "completed",
        reviewId: readString(params, "reviewId"),
        targetItemId: readNullableString(params, "targetItemId"),
        decisionSource: readString(params, "decisionSource"),
        status: review ? readString(review, "status") : undefined,
        riskLevel: review ? readString(review, "riskLevel") : undefined,
        userAuthorization: review ? readString(review, "userAuthorization") : undefined,
        rationale: review ? readNullableString(review, "rationale") : undefined,
        actionType: action ? readString(action, "type") : undefined,
      },
    });
  }

  handleGuardianWarning(params: JsonObject): void {
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: { phase: "warning", message: readString(params, "message") },
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
