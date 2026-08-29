/** ACP prompt submission, Gateway chat streaming, and prompt settlement. */
import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  AgentSideConnection,
  CancelNotification,
  PromptRequest,
  PromptResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import { readBool, readMetadataString, readNonNegativeInteger } from "@openclaw/acp-core/meta";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { normalizeTerminalChatSendAckStatus } from "../shared/chat-send-ack-status.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { shortenHomePath } from "../utils.js";
import { extractAttachmentsFromPrompt, extractTextFromPrompt } from "./event-mapper.js";
import { parseSessionMeta } from "./session-mapper.js";
import { AcpTranslatorAgentEvents } from "./translator.agent-events.js";
import { AcpTranslatorDisconnects } from "./translator.disconnects.js";
import type {
  AcpAgentWaitResult,
  AcpPendingApprovalRelay,
  AcpPendingPrompt,
} from "./translator.prompt-state.js";
import type { GatewayChatContentBlock } from "./translator.replay.js";
import type { AcpTranslatorSessionState } from "./translator.session-state.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

// Maximum allowed prompt size (2MB) to prevent DoS via memory exhaustion (CWE-400, GHSA-cxpw-2g23-2vgw)
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
// Shutdown owns only a brief best-effort abort window so EOF and signals cannot
// inherit the Gateway client's normal request timeout before process teardown.
const ACP_SHUTDOWN_ABORT_TIMEOUT_MS = 1_000;

type ChatSendAck = {
  runId?: unknown;
  status?: unknown;
};

type AcpPendingPromptAdmission = {
  session: NonNullable<ReturnType<AcpSessionStore["getSession"]>>;
  previous?: AcpPendingPromptAdmission;
  closed: boolean;
  closure: Deferred;
  settled: Deferred;
};

function isAdminScopeProvenanceRejection(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode =
    typeof (err as { gatewayCode?: unknown }).gatewayCode === "string"
      ? (err as { gatewayCode?: string }).gatewayCode
      : undefined;
  return (
    err.name === "GatewayClientRequestError" &&
    gatewayCode === "INVALID_REQUEST" &&
    err.message.includes("system provenance fields require admin scope")
  );
}

function isGatewayCloseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("gateway closed (");
}

function buildSystemInputProvenance(originSessionId: string) {
  return {
    kind: "external_user" as const,
    originSessionId,
    sourceChannel: "acp",
    sourceTool: "openclaw_acp",
  };
}

function buildSystemProvenanceReceipt(params: {
  cwd: string;
  sessionId: string;
  sessionKey: string;
}) {
  return [
    "[Source Receipt]",
    "bridge=openclaw-acp",
    `originHost=${os.hostname()}`,
    `originCwd=${shortenHomePath(params.cwd)}`,
    `acpSessionId=${params.sessionId}`,
    `originSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}

export class AcpTranslatorPromptStream {
  private readonly pendingPrompts = new Map<string, AcpPendingPrompt>();
  private readonly pendingPromptAdmissions = new Map<string, AcpPendingPromptAdmission>();
  private readonly settlingPromptKeys = new Set<string>();
  private readonly agentEvents: AcpTranslatorAgentEvents;
  private readonly disconnects: AcpTranslatorDisconnects;
  private stopped = false;

  constructor(
    connection: AgentSideConnection,
    private readonly gateway: GatewayClient,
    private readonly opts: AcpServerOptions,
    private readonly sessionStore: AcpSessionStore,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly sessionState: AcpTranslatorSessionState,
    readonly approvalRelays: Map<string, AcpPendingApprovalRelay>,
    private readonly log: (msg: string) => void,
  ) {
    this.agentEvents = new AcpTranslatorAgentEvents(
      connection,
      gateway,
      sessionUpdates,
      this.pendingPrompts,
      this.approvalRelays,
      (sessionId, runId) => this.getPendingPrompt(sessionId, runId),
      (sessionKey, runId) => this.findPendingBySessionKey(sessionKey, runId),
      log,
    );
    this.disconnects = new AcpTranslatorDisconnects(
      gateway,
      this.pendingPrompts,
      (sessionId, runId) => this.getPendingPrompt(sessionId, runId),
      (sessionId, pending, result) => this.settleRecoveredPrompt(sessionId, pending, result),
      (pending, error, options) => this.rejectPendingPrompt(pending, error, options),
      log,
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.disconnects.shutdown();
    const sessions = new Map<
      string,
      { sessionId: string; sessionKey: string; activeRunId: string | null }
    >();
    for (const pending of this.pendingPrompts.values()) {
      sessions.set(pending.sessionId, {
        sessionId: pending.sessionId,
        sessionKey: pending.sessionKey,
        activeRunId: pending.idempotencyKey,
      });
    }
    for (const admission of this.pendingPromptAdmissions.values()) {
      sessions.set(admission.session.sessionId, admission.session);
    }
    await Promise.all(
      [...sessions.values()].map((session) =>
        this.cancelSessionWork(session, ACP_SHUTDOWN_ABORT_TIMEOUT_MS),
      ),
    );
  }

  handleGatewayReconnect(): void {
    this.disconnects.handleGatewayReconnect();
  }

  handleGatewayDisconnect(reason: string): void {
    this.disconnects.handleGatewayDisconnect(reason);
  }

  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    if (evt.event === "chat") {
      await this.handleChatEvent(evt);
      return;
    }
    if (evt.event === "exec.approval.requested") {
      this.agentEvents.handleExecApprovalRequestEvent(evt);
      return;
    }
    if (evt.event === "agent") {
      await this.agentEvents.handleAgentEvent(evt);
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const admission: AcpPendingPromptAdmission = {
      session,
      previous: this.pendingPromptAdmissions.get(params.sessionId),
      closed: this.stopped,
      closure: createDeferredCore(),
      settled: createDeferredCore(),
    };
    this.pendingPromptAdmissions.set(params.sessionId, admission);
    // Each predecessor already closed its own predecessor; keep its abort barrier intact.
    if (admission.previous) {
      admission.previous.closed = true;
    }

    try {
      if (!this.ownsPromptAdmission(admission)) {
        return { stopReason: "cancelled" };
      }
      if (session.abortController || this.pendingPrompts.has(params.sessionId)) {
        await Promise.race([
          this.cancelSessionWork(session, undefined, admission),
          admission.closure.promise,
        ]);
        // Cancellation or session closure can win while the previous Gateway abort is pending.
        if (!this.ownsPromptAdmission(admission)) {
          return { stopReason: "cancelled" };
        }
      }
      if (admission.previous) {
        // Abort the active owner first; explicit closure can still release a blocked predecessor.
        await Promise.race([admission.previous.settled.promise, admission.closure.promise]);
        if (!this.ownsPromptAdmission(admission)) {
          return { stopReason: "cancelled" };
        }
        // Closure traversal no longer needs a settled predecessor or its retained ancestors.
        admission.previous = undefined;
      }
      return await Promise.race([
        this.submitPrompt(params, session),
        admission.closure.promise.then(() => ({ stopReason: "cancelled" as const })),
      ]);
    } finally {
      admission.settled.resolve();
      if (this.pendingPromptAdmissions.get(params.sessionId) === admission) {
        this.pendingPromptAdmissions.delete(params.sessionId);
      }
    }
  }

  private submitPrompt(
    params: PromptRequest,
    session: AcpPendingPromptAdmission["session"],
  ): Promise<PromptResponse> {
    const meta = parseSessionMeta(params["_meta"]);
    // Pass MAX_PROMPT_BYTES so extractTextFromPrompt rejects oversized content
    // block-by-block, before the full string is ever assembled in memory (CWE-400)
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    const prefixCwd = meta.prefixCwd ?? this.opts.prefixCwd ?? true;
    const displayCwd = shortenHomePath(session.cwd);
    const message = prefixCwd ? `[Working directory: ${displayCwd}]\n\n${userText}` : userText;
    const provenanceMode = this.opts.provenanceMode ?? "off";
    const systemInputProvenance =
      provenanceMode === "off" ? undefined : buildSystemInputProvenance(params.sessionId);
    const systemProvenanceReceipt =
      provenanceMode === "meta+receipt"
        ? buildSystemProvenanceReceipt({
            cwd: session.cwd,
            sessionId: params.sessionId,
            sessionKey: session.sessionKey,
          })
        : undefined;

    // Defense-in-depth: also check the final assembled message (includes cwd prefix)
    if (Buffer.byteLength(message, "utf-8") > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }

    const abortController = new AbortController();
    const runId = randomUUID();
    this.sessionStore.setActiveRun(params.sessionId, runId, abortController);
    const requestParams = {
      sessionKey: session.sessionKey,
      message,
      attachments: attachments.length > 0 ? attachments : undefined,
      idempotencyKey: runId,
      thinking: readMetadataString(params["_meta"], ["thinking", "thinkingLevel"]),
      deliver: readBool(params["_meta"], ["deliver"]),
      timeoutMs: readNonNegativeInteger(params["_meta"], ["timeoutMs"]),
    };

    return new Promise<PromptResponse>((resolve, reject) => {
      this.pendingPrompts.set(params.sessionId, {
        sessionId: params.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        idempotencyKey: runId,
        disconnectContext: this.disconnects.activeContext ?? undefined,
        resolve,
        reject,
      });
      this.disconnects.armForActiveContext();

      const sendWithProvenanceFallback = async () => {
        const markSendAccepted = (): boolean => {
          const pending = this.getPendingPrompt(params.sessionId, runId);
          if (!pending) {
            return false;
          }
          pending.sendAccepted = true;
          return true;
        };
        const applyTerminalAck = async (ack: ChatSendAck | undefined): Promise<boolean> => {
          const status = normalizeTerminalChatSendAckStatus(ack?.status);
          const pending = () => this.getPendingPrompt(params.sessionId, runId);
          if (status === "timeout") {
            const current = pending();
            if (current) {
              await this.finishPrompt(params.sessionId, current, "cancelled");
            }
            return true;
          }
          if (status === "error") {
            const current = pending();
            if (current) {
              await this.rejectPendingPrompt(
                current,
                new Error("Chat failed before the run started; try again."),
              );
            }
            return true;
          }
          if (status === "ok") {
            if (!markSendAccepted()) {
              return true;
            }
            await this.sessionUpdates.recordUserPrompt(session, runId, params.prompt);
            const current = pending();
            if (current) {
              await this.finishPrompt(params.sessionId, current, "end_turn");
            }
            return true;
          }
          return false;
        };

        const sendChat = async (payload: Record<string, unknown>): Promise<boolean> => {
          const ack = await this.gateway.request<ChatSendAck>("chat.send", payload, {
            timeoutMs: null,
          });
          return await applyTerminalAck(ack);
        };

        try {
          const terminal = await sendChat({
            ...requestParams,
            systemInputProvenance,
            systemProvenanceReceipt,
          });
          if (terminal) {
            return;
          }
          if (!markSendAccepted()) {
            return;
          }
          await this.sessionUpdates.recordUserPrompt(session, runId, params.prompt);
        } catch (err) {
          if (
            (systemInputProvenance || systemProvenanceReceipt) &&
            isAdminScopeProvenanceRejection(err)
          ) {
            if (!this.getPendingPrompt(params.sessionId, runId)) {
              return;
            }
            const terminal = await sendChat(requestParams);
            if (terminal) {
              return;
            }
            if (!markSendAccepted()) {
              return;
            }
            await this.sessionUpdates.recordUserPrompt(session, runId, params.prompt);
            return;
          }
          throw err;
        }
      };

      void sendWithProvenanceFallback().catch(async (err: unknown) => {
        const promptKey = this.pendingPromptKey(params.sessionId, runId);
        if (this.settlingPromptKeys.has(promptKey)) {
          return;
        }
        if (isGatewayCloseError(err) && this.getPendingPrompt(params.sessionId, runId)) {
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        const current = this.getPendingPrompt(params.sessionId, runId);
        if (current) {
          await this.rejectPendingPrompt(current, error);
        }
      });
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      return;
    }
    await this.cancelSessionWork(session);
  }

  async cancelSessionWork(
    session: {
      sessionId: string;
      sessionKey: string;
      activeRunId: string | null;
    },
    abortTimeoutMs?: number,
    retainedAdmission?: AcpPendingPromptAdmission,
  ): Promise<void> {
    const closingAdmissions: Promise<void>[] = [];
    if (!retainedAdmission) {
      let admission = this.pendingPromptAdmissions.get(session.sessionId);
      while (admission) {
        admission.closed = true;
        admission.closure.resolve();
        closingAdmissions.push(admission.settled.promise);
        admission = admission.previous;
      }
    }

    const pending = this.pendingPrompts.get(session.sessionId);
    const scopedRunId = session.activeRunId ?? pending?.idempotencyKey;

    if (!scopedRunId) {
      await Promise.all(closingAdmissions);
      return;
    }

    this.sessionStore.cancelActiveRun(session.sessionId, scopedRunId);
    if (pending?.idempotencyKey === scopedRunId && this.claimPendingPrompt(pending)) {
      pending.resolve({ stopReason: "cancelled" });
    }

    try {
      const abortParams = {
        sessionKey: session.sessionKey,
        runId: scopedRunId,
      };
      await (abortTimeoutMs === undefined
        ? this.gateway.request("chat.abort", abortParams)
        : this.gateway.request("chat.abort", abortParams, { timeoutMs: abortTimeoutMs }));
    } catch (err) {
      this.log(`cancel error: ${String(err)}`);
    }
    await Promise.all(closingAdmissions);
  }

  private ownsPromptAdmission(admission: AcpPendingPromptAdmission): boolean {
    return (
      !this.stopped &&
      !admission.closed &&
      this.pendingPromptAdmissions.get(admission.session.sessionId) === admission &&
      this.sessionStore.getSession(admission.session.sessionId) === admission.session
    );
  }

  private pendingPromptKey(sessionId: string, runId: string): string {
    return `${sessionId}\u0000${runId}`;
  }

  private getPendingPrompt(sessionId: string, runId: string): AcpPendingPrompt | undefined {
    const pending = this.pendingPrompts.get(sessionId);
    if (pending?.idempotencyKey !== runId) {
      return undefined;
    }
    return pending;
  }

  private claimPendingPrompt(pending: AcpPendingPrompt): boolean {
    if (this.getPendingPrompt(pending.sessionId, pending.idempotencyKey) !== pending) {
      return false;
    }
    this.agentEvents.clearApprovalRelaysForPrompt(pending.sessionId, pending.idempotencyKey, {
      denyActive: true,
    });
    this.pendingPrompts.delete(pending.sessionId);
    this.sessionStore.clearActiveRun(pending.sessionId, pending.idempotencyKey);
    this.disconnects.clearWhenIdle();
    return true;
  }

  private async handleChatEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }

    const sessionKey = payload.sessionKey as string | undefined;
    const state = payload.state as string | undefined;
    const runId = payload.runId as string | undefined;
    const messageData = payload.message as Record<string, unknown> | undefined;
    if (!sessionKey || !state) {
      return;
    }

    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    const shouldHandleMessageSnapshot = messageData && (state === "delta" || state === "final");
    if (shouldHandleMessageSnapshot) {
      // Gateway chat events can carry the latest full assistant snapshot on both
      // incremental updates and the terminal final event. Process the snapshot
      // first so ACP clients never drop the last visible assistant text.
      const ownsSnapshot = await this.handleDeltaEvent(pending, messageData);
      if (
        !ownsSnapshot ||
        this.getPendingPrompt(pending.sessionId, pending.idempotencyKey) !== pending ||
        state === "delta"
      ) {
        return;
      }
    }

    if (state === "final") {
      const rawStopReason = payload.stopReason as string | undefined;
      const stopReason: StopReason = rawStopReason === "max_tokens" ? "max_tokens" : "end_turn";
      await this.finishPrompt(pending.sessionId, pending, stopReason);
      return;
    }
    if (state === "aborted") {
      // Claim before the first await so a stalled or rejected interruption
      // delivery cannot strand the prompt (same shape as settleRecoveredPrompt).
      if (!this.claimPendingPrompt(pending)) {
        return;
      }
      const errorMessage =
        typeof payload.errorMessage === "string" ? payload.errorMessage.trim() : undefined;
      if (errorMessage) {
        // The Gateway attaches the abort cause (e.g. tool validation failure)
        // to the event; surface it or the IDE shows a bare "cancelled" for a
        // run that actually died from an error. Nonblocking: the notice is
        // best-effort and must not hold terminal settlement hostage.
        await this.emitPromptChunk(
          pending,
          "agent_message_chunk",
          `[OpenClaw interruption] ${errorMessage}`,
          false,
        );
      }
      await this.finishPrompt(pending.sessionId, pending, "cancelled", { claimed: true });
      return;
    }
    if (state === "error") {
      const errorKind = payload.errorKind as string | undefined;
      const stopReason: StopReason = errorKind === "refusal" ? "refusal" : "end_turn";
      void this.finishPrompt(pending.sessionId, pending, stopReason);
    }
  }

  private async handleDeltaEvent(
    pending: AcpPendingPrompt,
    messageData: Record<string, unknown>,
  ): Promise<boolean> {
    const content = messageData.content as GatewayChatContentBlock[] | undefined;
    const sessionId = pending.sessionId;
    if (this.getPendingPrompt(sessionId, pending.idempotencyKey) !== pending) {
      return false;
    }

    const fullThought = content
      ?.filter((block) => block?.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("\n")
      .trimEnd();
    const sentThoughtSoFar = pending.sentThought?.length ?? 0;
    if (fullThought && fullThought.length > sentThoughtSoFar) {
      const newThought = fullThought.slice(sentThoughtSoFar);
      pending.sentThought = fullThought;
      await this.emitPromptChunk(pending, "agent_thought_chunk", newThought);
      if (this.getPendingPrompt(sessionId, pending.idempotencyKey) !== pending) {
        return false;
      }
    }

    const fullText = content
      ?.filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trimEnd();
    const sentSoFar = pending.sentText?.length ?? 0;
    if (!fullText || fullText.length <= sentSoFar) {
      return true;
    }

    const newText = fullText.slice(sentSoFar);
    pending.sentText = fullText;
    await this.emitPromptChunk(pending, "agent_message_chunk", newText);
    return this.getPendingPrompt(sessionId, pending.idempotencyKey) === pending;
  }

  private async finishPrompt(
    sessionId: string,
    pending: AcpPendingPrompt,
    stopReason: StopReason,
    options: { claimed?: boolean } = {},
  ): Promise<void> {
    if (!options.claimed && !this.claimPendingPrompt(pending)) {
      return;
    }
    const promptKey = this.pendingPromptKey(sessionId, pending.idempotencyKey);
    this.settlingPromptKeys.add(promptKey);
    try {
      const sessionSnapshot = await this.sessionState.getSnapshot(pending.sessionKey);
      try {
        await this.sessionState.sendSnapshotUpdate(
          {
            sessionId,
            sessionKey: pending.sessionKey,
            ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
          },
          sessionSnapshot,
          {
            includeControls: false,
            record: true,
            runId: pending.idempotencyKey,
          },
        );
      } catch (err) {
        this.log(`session snapshot update failed for ${sessionId}: ${String(err)}`);
      }
      pending.resolve({ stopReason });
    } finally {
      this.settlingPromptKeys.delete(promptKey);
    }
  }

  private async emitPromptChunk(
    pending: AcpPendingPrompt,
    kind: "agent_message_chunk" | "agent_thought_chunk",
    text: string,
    waitForDelivery = true,
  ): Promise<void> {
    await this.sessionUpdates.emit({
      sessionId: pending.sessionId,
      sessionKey: pending.sessionKey,
      ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
      runId: pending.idempotencyKey,
      record: true,
      ...(waitForDelivery ? {} : { waitForDelivery: false }),
      update: {
        sessionUpdate: kind,
        content: { type: "text", text },
      },
    });
  }

  private async settleRecoveredPrompt(
    sessionId: string,
    pending: AcpPendingPrompt,
    result: AcpAgentWaitResult,
  ): Promise<void> {
    // Claim before the first await so late chat events cannot deliver or settle
    // the same prompt a second time.
    if (!this.claimPendingPrompt(pending)) {
      return;
    }
    const terminalReply = result.terminalReply;
    if (terminalReply?.disposition === "visible") {
      const sentText = (pending.sentText ?? "").trimStart();
      const recoveredText = terminalReply.text.startsWith(sentText)
        ? terminalReply.text.slice(sentText.length)
        : "";
      if (recoveredText) {
        await this.emitPromptChunk(pending, "agent_message_chunk", recoveredText, false);
      }
    }
    if (result.status !== "error") {
      await this.finishPrompt(sessionId, pending, "end_turn", { claimed: true });
      return;
    }
    const message = result.error?.trim() || "run failed";
    await this.emitPromptChunk(
      pending,
      "agent_message_chunk",
      `[OpenClaw interruption] ${message}`,
      false,
    );
    await this.rejectPendingPrompt(pending, new Error(message), { claimed: true });
  }

  private findPendingBySessionKey(
    sessionKey: string,
    runId?: string,
  ): AcpPendingPrompt | undefined {
    for (const pending of this.pendingPrompts.values()) {
      if (pending.sessionKey !== sessionKey) {
        continue;
      }
      if (runId && pending.idempotencyKey !== runId) {
        continue;
      }
      return pending;
    }
    if (runId) {
      for (const pending of this.pendingPrompts.values()) {
        if (pending.idempotencyKey !== runId) {
          continue;
        }
        this.reconcilePendingSessionKey(pending, sessionKey);
        return pending;
      }
    }
    return undefined;
  }

  private reconcilePendingSessionKey(pending: AcpPendingPrompt, sessionKey: string): void {
    if (pending.sessionKey === sessionKey) {
      return;
    }
    this.log(`session key reconciled: ${pending.sessionKey} -> ${sessionKey}`);
    pending.sessionKey = sessionKey;
    const session = this.sessionStore.getSession(pending.sessionId);
    if (session?.activeRunId === pending.idempotencyKey) {
      session.sessionKey = sessionKey;
    }
  }

  private async rejectPendingPrompt(
    pending: AcpPendingPrompt,
    error: Error,
    options: { claimed?: boolean; recordDisconnectNotice?: boolean } = {},
  ): Promise<void> {
    if (!options.claimed && !this.claimPendingPrompt(pending)) {
      return;
    }

    const promptKey = this.pendingPromptKey(pending.sessionId, pending.idempotencyKey);
    this.settlingPromptKeys.add(promptKey);

    try {
      if (options.recordDisconnectNotice) {
        const text = pending.sendAccepted
          ? "[OpenClaw interruption] The Gateway disconnected after accepting this message, so its final outcome is unknown. Check the session before retrying."
          : "[OpenClaw interruption] The Gateway disconnected before OpenClaw could confirm whether this message was accepted, so its final outcome is unknown. Check the session before retrying.";
        await this.emitPromptChunk(pending, "agent_message_chunk", text, false);
      }
    } catch (noticeError) {
      this.log(`disconnect notice failed for ${pending.idempotencyKey}: ${String(noticeError)}`);
    } finally {
      pending.reject(error);
      this.settlingPromptKeys.delete(promptKey);
    }
  }
}
