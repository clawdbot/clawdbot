import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { isMessagingToolSendAction } from "../../agents/embedded-agent-messaging.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ReplyPayload } from "../types.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createCompactionHookNoticePayload,
  createCompactionNoticePayload,
  formatCompactionModelRef,
  readCompactionHookMessages,
} from "./compaction-notice.js";

const agentCompactionLog = createSubsystemLogger("auto-reply/compaction");
const CODEX_APP_SERVER_COMPACTION_BACKEND = "codex-app-server";

export type MessageToolDeliveryState = {
  toolCallIds: Set<string>;
  completed: boolean;
};

function readApprovalScopeValue(value: unknown): "turn" | "session" | undefined {
  return value === "turn" || value === "session" ? value : undefined;
}

/** Bridges embedded-agent events into channel progress and compaction notices. */
export function createAgentRunEventHandler(params: {
  turn: AgentTurnParams;
  lifecycleBackstop: AgentLifecycleTerminalBackstop;
  notifyAgentRunStart: () => void;
  sourceRepliesAreToolOnly: boolean;
  provider: string;
  model: string;
  effectiveSessionId?: string;
  notifyUserAboutCompaction: boolean;
  onCompactionCompleted: () => number;
  messageToolDeliveryState: MessageToolDeliveryState;
}): NonNullable<RunEmbeddedAgentParams["onAgentEvent"]> {
  const commentaryTextByItem = new Map<string, string>();
  const lastEmittedCommentaryByItem = new Map<string, string>();
  const shouldSuppressProgressAfterMessageToolDelivery = () =>
    params.sourceRepliesAreToolOnly &&
    params.messageToolDeliveryState.completed &&
    params.turn.opts?.allowProgressCallbacksWhenSourceDeliverySuppressed !== true;

  const currentMessageId =
    params.turn.sessionCtx.MessageSidFull ?? params.turn.sessionCtx.MessageSid;
  const deliverCompactionNoticePayload = async (noticePayload: ReplyPayload, label: string) => {
    const deliver = params.turn.opts?.onBlockReply ?? params.turn.onCompactionNoticePayload;
    if (!deliver) {
      return;
    }
    try {
      await deliver(noticePayload);
    } catch (err) {
      logVerbose(`compaction ${label} notice delivery failed (non-fatal): ${String(err)}`);
    }
  };
  const sendCompactionNotice = async (phase: "start" | "end" | "incomplete") => {
    await deliverCompactionNoticePayload(
      createCompactionNoticePayload({
        phase,
        currentMessageId,
        applyReplyToMode: params.turn.applyReplyToMode,
      }),
      phase,
    );
  };
  const sendCompactionHookMessages = async (messages: string[]) => {
    const noticePayload = createCompactionHookNoticePayload({
      messages,
      currentMessageId,
      applyReplyToMode: params.turn.applyReplyToMode,
    });
    if (noticePayload) {
      await deliverCompactionNoticePayload(noticePayload, "hook");
    }
  };

  return async (evt) => {
    params.turn.replyOperation?.recordActivity();
    params.lifecycleBackstop.note(evt);
    const hasLifecyclePhase = evt.stream === "lifecycle" && typeof evt.data.phase === "string";
    if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
      params.notifyAgentRunStart();
    }
    if (evt.stream === "tool" && evt.data.hideFromChannelProgress !== true) {
      const phase = readStringValue(evt.data.phase) ?? "";
      const name = readStringValue(evt.data.name);
      const toolCallId = readStringValue(evt.data.toolCallId) ?? "";
      const args =
        evt.data.args && typeof evt.data.args === "object"
          ? (evt.data.args as Record<string, unknown>)
          : undefined;
      if (
        params.sourceRepliesAreToolOnly &&
        toolCallId &&
        name &&
        (phase === "start" || phase === "update") &&
        args &&
        isMessagingToolSendAction(name, args)
      ) {
        params.messageToolDeliveryState.toolCallIds.add(toolCallId);
      }
      if (shouldSuppressProgressAfterMessageToolDelivery()) {
        return;
      }
      if (phase === "start" || phase === "update") {
        const toolStartProgressPromise = params.turn.opts?.onToolStart?.({
          itemId: readStringValue(evt.data.itemId),
          toolCallId: readStringValue(evt.data.toolCallId),
          name,
          phase,
          args,
          detailMode: params.turn.toolProgressDetail,
        });
        await Promise.all([params.turn.typingSignals.signalToolStart(), toolStartProgressPromise]);
      }
      const commandOutput = buildCommandOutputFromToolResultEvent(evt);
      if (commandOutput) {
        await params.turn.opts?.onCommandOutput?.(commandOutput);
      }
    }

    const suppressItemChannelProgress =
      evt.stream === "item" &&
      evt.data.suppressChannelProgress === true &&
      Boolean(params.turn.opts?.onToolStart);
    const hideItemFromChannelProgress =
      evt.stream === "item" && evt.data.hideFromChannelProgress === true;
    const itemPhase = evt.stream === "item" ? readStringValue(evt.data.phase) : "";
    const itemName = evt.stream === "item" ? readStringValue(evt.data.name) : "";
    const itemStatus = evt.stream === "item" ? readStringValue(evt.data.status) : "";
    const itemToolCallId =
      evt.stream === "item" ? (readStringValue(evt.data.toolCallId) ?? "") : "";
    const completedMessageToolDelivery =
      params.sourceRepliesAreToolOnly &&
      itemPhase === "end" &&
      itemStatus === "completed" &&
      itemToolCallId.length > 0 &&
      params.messageToolDeliveryState.toolCallIds.has(itemToolCallId);
    const suppressProgressAfterMessageToolDelivery =
      shouldSuppressProgressAfterMessageToolDelivery();
    if (completedMessageToolDelivery) {
      params.messageToolDeliveryState.toolCallIds.delete(itemToolCallId);
      params.messageToolDeliveryState.completed = true;
    }

    if (
      evt.stream === "assistant" &&
      readStringValue(evt.data.phase) === "commentary" &&
      !shouldSuppressProgressAfterMessageToolDelivery()
    ) {
      const commentaryItemId = readStringValue(evt.data.itemId) ?? "";
      const snapshotText = readStringValue(evt.data.text);
      const deltaText = readStringValue(evt.data.delta);
      const accumulated =
        evt.data.replace === true && snapshotText
          ? snapshotText
          : deltaText
            ? `${commentaryTextByItem.get(commentaryItemId) ?? ""}${deltaText}`
            : (snapshotText ?? "");
      commentaryTextByItem.set(commentaryItemId, accumulated);
      const commentaryText = accumulated.replace(/\s+/g, " ").trim();
      if (commentaryText && lastEmittedCommentaryByItem.get(commentaryItemId) !== commentaryText) {
        lastEmittedCommentaryByItem.set(commentaryItemId, commentaryText);
        await params.turn.opts?.onItemEvent?.({
          itemId: commentaryItemId || undefined,
          kind: "preamble",
          title: "Preamble",
          phase: "update",
          progressText: commentaryText,
        });
      }
    }
    if (
      evt.stream === "item" &&
      !hideItemFromChannelProgress &&
      !suppressItemChannelProgress &&
      (!suppressProgressAfterMessageToolDelivery || completedMessageToolDelivery)
    ) {
      await params.turn.opts?.onItemEvent?.({
        itemId: readStringValue(evt.data.itemId),
        toolCallId: readStringValue(evt.data.toolCallId),
        kind: readStringValue(evt.data.kind),
        title: readStringValue(evt.data.title),
        name: itemName,
        phase: itemPhase,
        status: itemStatus,
        summary: readStringValue(evt.data.summary),
        progressText: readStringValue(evt.data.progressText),
        meta: readStringValue(evt.data.meta),
        approvalId: readStringValue(evt.data.approvalId),
        approvalSlug: readStringValue(evt.data.approvalSlug),
      });
    }
    if (evt.stream === "plan" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      await params.turn.opts?.onPlanUpdate?.({
        phase: readStringValue(evt.data.phase),
        title: readStringValue(evt.data.title),
        explanation: readStringValue(evt.data.explanation),
        steps: Array.isArray(evt.data.steps)
          ? evt.data.steps.filter((step): step is string => typeof step === "string")
          : undefined,
        source: readStringValue(evt.data.source),
      });
    }
    if (evt.stream === "approval" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      await params.turn.opts?.onApprovalEvent?.({
        phase: readStringValue(evt.data.phase),
        kind: readStringValue(evt.data.kind),
        status: readStringValue(evt.data.status),
        title: readStringValue(evt.data.title),
        itemId: readStringValue(evt.data.itemId),
        toolCallId: readStringValue(evt.data.toolCallId),
        approvalId: readStringValue(evt.data.approvalId),
        approvalSlug: readStringValue(evt.data.approvalSlug),
        command: readStringValue(evt.data.command),
        host: readStringValue(evt.data.host),
        reason: readStringValue(evt.data.reason),
        scope: readApprovalScopeValue(evt.data.scope),
        message: readStringValue(evt.data.message),
      });
    }
    if (evt.stream === "command_output" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      await params.turn.opts?.onCommandOutput?.({
        itemId: readStringValue(evt.data.itemId),
        phase: readStringValue(evt.data.phase),
        title: readStringValue(evt.data.title),
        toolCallId: readStringValue(evt.data.toolCallId),
        name: readStringValue(evt.data.name),
        output: readStringValue(evt.data.output),
        status: readStringValue(evt.data.status),
        exitCode:
          typeof evt.data.exitCode === "number" || evt.data.exitCode === null
            ? evt.data.exitCode
            : undefined,
        durationMs: typeof evt.data.durationMs === "number" ? evt.data.durationMs : undefined,
        cwd: readStringValue(evt.data.cwd),
      });
    }
    if (evt.stream === "patch" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      await params.turn.opts?.onPatchSummary?.({
        itemId: readStringValue(evt.data.itemId),
        phase: readStringValue(evt.data.phase),
        title: readStringValue(evt.data.title),
        toolCallId: readStringValue(evt.data.toolCallId),
        name: readStringValue(evt.data.name),
        added: Array.isArray(evt.data.added)
          ? evt.data.added.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        modified: Array.isArray(evt.data.modified)
          ? evt.data.modified.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        deleted: Array.isArray(evt.data.deleted)
          ? evt.data.deleted.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        summary: readStringValue(evt.data.summary),
      });
    }
    if (evt.stream !== "compaction") {
      return;
    }

    const phase = readStringValue(evt.data.phase) ?? "";
    const backend = readStringValue(evt.data.backend);
    const hookMessages = readCompactionHookMessages(evt.data.messages);
    const sendCompactionUserNotices = async (noticePhase: "start" | "end" | "incomplete") => {
      if (hookMessages.length > 0) {
        await sendCompactionHookMessages(hookMessages);
      }
      if (params.notifyUserAboutCompaction) {
        await sendCompactionNotice(noticePhase);
      }
    };
    if (phase === "start") {
      await params.turn.opts?.onCompactionStart?.();
      await sendCompactionUserNotices("start");
      return;
    }
    if (phase !== "end") {
      return;
    }
    if (evt.data.completed !== true) {
      await sendCompactionUserNotices("incomplete");
      return;
    }

    const compactionCount = params.onCompactionCompleted();
    if (backend === CODEX_APP_SERVER_COMPACTION_BACKEND) {
      const modelRef = formatCompactionModelRef(params.provider, params.model);
      const consoleMessage =
        `codex app-server auto-compaction succeeded for ${modelRef}; ` +
        "refreshed session context";
      agentCompactionLog.info("codex app-server auto-compaction succeeded", {
        event: "codex_app_server_compaction_succeeded",
        backend,
        provider: params.provider,
        model: params.model,
        sessionKey: params.turn.sessionKey,
        sessionId: params.effectiveSessionId,
        threadId: readStringValue(evt.data.threadId),
        turnId: readStringValue(evt.data.turnId),
        itemId: readStringValue(evt.data.itemId),
        compactionCount,
        consoleMessage,
      });
    }
    await params.turn.opts?.onCompactionEnd?.();
    await sendCompactionUserNotices("end");
  };
}
