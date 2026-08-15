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
import { normalizeLowercaseStringOrEmpty as normalizedChatSendAckStatus } from "@openclaw/normalization-core/string-coerce";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { shortenHomePath } from "../utils.js";
import { extractAttachmentsFromPrompt, extractTextFromPrompt } from "./event-mapper.js";
import { parseSessionMeta } from "./session-mapper.js";
import { AcpTranslatorAgentEvents } from "./translator.agent-events.js";
import { AcpTranslatorDisconnects } from "./translator.disconnects.js";
import type { AcpPendingApprovalRelay, AcpPendingPrompt } from "./translator.prompt-state.js";
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

function isTerminalChatSendAckFailure(status: unknown): boolean {
  const normalized = normalizedChatSendAckStatus(status);
  return normalized === "timeout" || normalized === "error";
}

function isTerminalChatSendAckSuccess(status: unknown): boolean {
  return normalizedChatSendAckStatus(status) === "ok";
}

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
  cwd?: string;
  sessionId: string;
  sessionKey: string;
}) {
  return [
    "[Source Receipt]",
    "bridge=openclaw-acp",
    `originHost=${os.hostname()}`,
    // Omitted rather than guessed when the adopted session's runtime directory is unknown.
    ...(params.cwd ? [`originCwd=${shortenHomePath(params.cwd)}`] : []),
    `acpSessionId=${params.sessionId}`,
    `originSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}

export class AcpTranslatorPromptStream {
  private readonly pendingPrompts = new Map<string, AcpPendingPrompt>();
  private readonly settlingPromptKeys = new Set<string>();
  private readonly agentEvents: AcpTranslatorAgentEvents;
  private readonly disconnects: AcpTranslatorDisconnects;

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
      (sessionId, pending, stopReason) => this.finishPrompt(sessionId, pending, stopReason),
      (pending, error, options) => this.rejectPendingPrompt(pending, error, options),
      log,
    );
  }

  async shutdown(): Promise<void> {
    this.disconnects.shutdown();
    await Promise.all(
      [...this.pendingPrompts.values()].map((pending) =>
        this.cancelSessionWork(
          {
            sessionId: pending.sessionId,
            sessionKey: pending.sessionKey,
            activeRunId: pending.idempotencyKey,
          },
          ACP_SHUTDOWN_ABORT_TIMEOUT_MS,
        ),
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

    if (session.abortController) {
      this.sessionStore.cancelActiveRun(params.sessionId);
    }

    const meta = parseSessionMeta(params["_meta"]);
    // Pass MAX_PROMPT_BYTES so extractTextFromPrompt rejects oversized content
    // block-by-block, before the full string is ever assembled in memory (CWE-400)
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    // Only state a working directory the turn will actually use; an adopted session whose row
    // records none leaves this unknown, and naming the client's path there would tell the model
    // it is somewhere Gateway never puts it.
    const prefixCwd =
      (meta.prefixCwd ?? this.opts.prefixCwd ?? true) && session.runtimeCwd !== false;
    const displayCwd = shortenHomePath(session.cwd);
    const message = prefixCwd ? `[Working directory: ${displayCwd}]\n\n${userText}` : userText;
    const provenanceMode = this.opts.provenanceMode ?? "off";
    const systemInputProvenance =
      provenanceMode === "off" ? undefined : buildSystemInputProvenance(params.sessionId);
    const systemProvenanceReceipt =
      provenanceMode === "meta+receipt"
        ? buildSystemProvenanceReceipt({
            ...(session.runtimeCwd === false ? {} : { cwd: session.cwd }),
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
        const markSendAccepted = () => {
          const pending = this.getPendingPrompt(params.sessionId, runId);
          if (pending) {
            pending.sendAccepted = true;
          }
        };
        const applyTerminalAck = async (ack: ChatSendAck | undefined): Promise<boolean> => {
          const status = normalizedChatSendAckStatus(ack?.status);
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
            markSendAccepted();
            await this.sessionUpdates.recordUserPrompt(session, runId, params.prompt);
            const current = pending();
            if (current) {
              await this.finishPrompt(params.sessionId, current, "end_turn");
            }
            return true;
          }
          return isTerminalChatSendAckFailure(status) || isTerminalChatSendAckSuccess(status);
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
          markSendAccepted();
          await this.sessionUpdates.recordUserPrompt(session, runId, params.prompt);
        } catch (err) {
          if (
            (systemInputProvenance || systemProvenanceReceipt) &&
            isAdminScopeProvenanceRejection(err)
          ) {
            const terminal = await sendChat(requestParams);
            if (terminal) {
              return;
            }
            markSendAccepted();
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
          return;
        }
        reject(error);
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
  ): Promise<void> {
    // Capture runId before cancelActiveRun clears session.activeRunId.
    const activeRunId = session.activeRunId;

    this.sessionStore.cancelActiveRun(session.sessionId);
    const pending = this.pendingPrompts.get(session.sessionId);
    const scopedRunId = activeRunId ?? pending?.idempotencyKey;

    if (scopedRunId) {
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
    }

    if (pending) {
      this.agentEvents.clearApprovalRelaysForPrompt(session.sessionId, pending.idempotencyKey, {
        denyActive: true,
      });
      this.pendingPrompts.delete(session.sessionId);
      this.disconnects.clearWhenIdle();
      pending.resolve({ stopReason: "cancelled" });
    }
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
      await this.handleDeltaEvent(pending.sessionId, messageData);
      if (state === "delta") {
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
      await this.finishPrompt(pending.sessionId, pending, "cancelled");
      return;
    }
    if (state === "error") {
      const errorKind = payload.errorKind as string | undefined;
      const stopReason: StopReason = errorKind === "refusal" ? "refusal" : "end_turn";
      void this.finishPrompt(pending.sessionId, pending, stopReason);
    }
  }

  private async handleDeltaEvent(
    sessionId: string,
    messageData: Record<string, unknown>,
  ): Promise<void> {
    const content = messageData.content as GatewayChatContentBlock[] | undefined;
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) {
      return;
    }

    const fullThought = content
      ?.filter((block) => block?.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("\n")
      .trimEnd();
    const sentThoughtSoFar = pending.sentThoughtLength ?? 0;
    if (fullThought && fullThought.length > sentThoughtSoFar) {
      const newThought = fullThought.slice(sentThoughtSoFar);
      pending.sentThoughtLength = fullThought.length;
      pending.sentThought = fullThought;
      await this.sessionUpdates.emit({
        sessionId,
        sessionKey: pending.sessionKey,
        ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
        runId: pending.idempotencyKey,
        record: true,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: newThought },
        },
      });
    }

    const fullText = content
      ?.filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trimEnd();
    const sentSoFar = pending.sentTextLength ?? 0;
    if (!fullText || fullText.length <= sentSoFar) {
      return;
    }

    const newText = fullText.slice(sentSoFar);
    pending.sentTextLength = fullText.length;
    pending.sentText = fullText;
    await this.sessionUpdates.emit({
      sessionId,
      sessionKey: pending.sessionKey,
      ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
      runId: pending.idempotencyKey,
      record: true,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: newText },
      },
    });
  }

  private async finishPrompt(
    sessionId: string,
    pending: AcpPendingPrompt,
    stopReason: StopReason,
  ): Promise<void> {
    const promptKey = this.pendingPromptKey(sessionId, pending.idempotencyKey);
    this.settlingPromptKeys.add(promptKey);
    try {
      this.agentEvents.clearApprovalRelaysForPrompt(sessionId, pending.idempotencyKey, {
        denyActive: true,
      });
      this.pendingPrompts.delete(sessionId);
      this.sessionStore.clearActiveRun(sessionId);
      this.disconnects.clearWhenIdle();
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
    options: { recordDisconnectNotice?: boolean } = {},
  ): Promise<void> {
    const currentPending = this.getPendingPrompt(pending.sessionId, pending.idempotencyKey);
    if (currentPending !== pending) {
      return;
    }

    const promptKey = this.pendingPromptKey(pending.sessionId, pending.idempotencyKey);
    // Claim before emitting so late Gateway events cannot settle this prompt twice.
    this.settlingPromptKeys.add(promptKey);
    this.agentEvents.clearApprovalRelaysForPrompt(pending.sessionId, pending.idempotencyKey, {
      denyActive: true,
    });
    this.pendingPrompts.delete(pending.sessionId);
    this.sessionStore.clearActiveRun(pending.sessionId);
    this.disconnects.clearWhenIdle();

    try {
      if (options.recordDisconnectNotice) {
        const text = pending.sendAccepted
          ? "[OpenClaw interruption] The Gateway disconnected after accepting this message, so its final outcome is unknown. Check the session before retrying."
          : "[OpenClaw interruption] The Gateway disconnected before OpenClaw could confirm whether this message was accepted, so its final outcome is unknown. Check the session before retrying.";
        // Make replay durable before rejecting, but do not let ACP client backpressure
        // extend the disconnect deadline indefinitely.
        await this.sessionUpdates.emit({
          sessionId: pending.sessionId,
          sessionKey: pending.sessionKey,
          ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
          runId: pending.idempotencyKey,
          record: true,
          waitForDelivery: false,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      }
    } catch (noticeError) {
      this.log(`disconnect notice failed for ${pending.idempotencyKey}: ${String(noticeError)}`);
    } finally {
      pending.reject(error);
      this.settlingPromptKeys.delete(promptKey);
    }
  }
}
