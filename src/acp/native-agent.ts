/** Self-contained ACP agent backed by OpenClaw's canonical in-process runner. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "../agents/embedded-agent-runner/run/attempt.abort-settle-timeout.js";
import type { LocalExecApprovalRequest } from "../agents/local-exec-approval-broker.js";
import { getRuntimeConfig } from "../config/config.js";
import { type AgentEventPayload, onAgentEvent } from "../infra/agent-events.js";
import { buildApprovalPresentation } from "../infra/approval-presentation.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  clearEmbeddedPluginApprovalBroker,
  type EmbeddedPluginApprovalRequest,
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import {
  createFixedWindowRateLimiter,
  resolveFixedWindowRateLimitInteger,
  type FixedWindowRateLimiter,
} from "../infra/fixed-window-rate-limit.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { extractAttachmentsFromPrompt, extractTextFromPrompt } from "./event-mapper.js";
import { agentResultError, finalVisibleText, type AgentResult } from "./native-agent-result.js";
import {
  buildAcpPermissionRequest,
  resolveGatewayDecisionFromPermissionOutcome,
} from "./permission-relay.js";
import { ACP_AGENT_INFO } from "./types.js";

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_ACP_PROMPT_ERROR_CHARS = 1_000;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

const silentRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (code) => {
    throw new Error(`unexpected agent runtime exit ${code}`);
  },
};

function toAcpPromptRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) {
    return error;
  }
  const detail = truncateUtf16Safe(
    sanitizeTerminalText(formatErrorMessage(error)).trim(),
    MAX_ACP_PROMPT_ERROR_CHARS,
  );
  return RequestError.internalError(
    { kind: "agent_execution_failed" },
    `agent prompt failed: ${detail || "unknown error"}`,
  );
}

type AgentExecutor = typeof agentCommandFromIngress;

type NativeSession = {
  id: string;
  key: string;
  cwd: string;
  promptGeneration: number;
};

type ActiveTurn = {
  runId: string;
  controller: AbortController;
  completion: Promise<PromptResponse>;
};

type NativeAgentDependencies = {
  executeAgent?: AgentExecutor;
  createId?: () => string;
  subscribeAgentEvents?: typeof onAgentEvent;
  resolveAgentId?: () => string;
  runtime?: RuntimeEnv;
  sessionCreateRateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
  abortSettleTimeoutMs?: number;
};

function buildNativeSessionKey(params: { agentId: string; sessionId: string }): string {
  // The `acp:` namespace is reserved for sessions backed by an external ACP
  // runtime. Native ACP already owns the model loop, so using it would reroute
  // this in-process turn through the ACP session manager.
  return toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: `native-acp:${params.sessionId}`,
  });
}

function permissionOptions(decisions: readonly ExecApprovalDecision[]): PermissionOption[] {
  return decisions.map((decision) => ({
    optionId: decision,
    name:
      decision === "allow-once"
        ? "Allow once"
        : decision === "allow-always"
          ? "Allow always"
          : "Deny",
    kind:
      decision === "allow-once"
        ? "allow_once"
        : decision === "allow-always"
          ? "allow_always"
          : "reject_once",
  }));
}

function pluginPermissionRequest(
  sessionId: string,
  approval: PluginApprovalRequest,
): RequestPermissionRequest | null {
  const request = approval.request;
  const allowedDecisions = resolveCanonicalPluginApprovalRequestAllowedDecisions(request);
  const presentation = buildApprovalPresentation({
    kind: "plugin",
    request,
    allowedDecisions,
  });
  if (!presentation || presentation.kind !== "plugin") {
    return null;
  }
  const toolName = presentation.toolName ?? presentation.pluginId ?? "plugin";
  const options = permissionOptions(allowedDecisions);
  return {
    sessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? approval.id,
      title: presentation.title,
      kind: "other",
      status: "pending",
      rawInput: {
        name: toolName,
        approvalId: approval.id,
        description: presentation.description,
        ...(presentation.detail ? { detail: presentation.detail } : {}),
        ...(presentation.pluginId ? { pluginId: presentation.pluginId } : {}),
      },
      _meta: {
        toolName,
        approvalId: approval.id,
      },
    },
    options,
  };
}

async function requestPermissionWithSignal(params: {
  connection: AgentSideConnection;
  request: RequestPermissionRequest;
  signal: AbortSignal;
}): Promise<RequestPermissionResponse | undefined> {
  if (params.signal.aborted) {
    return undefined;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([params.connection.requestPermission(params.request), aborted]);
  } catch {
    return undefined;
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

function resolveSessionForPluginApproval(
  sessions: Iterable<NativeSession>,
  request: PluginApprovalRequestPayload,
): NativeSession | undefined {
  if (request.sessionKey) {
    for (const session of sessions) {
      if (session.key === request.sessionKey) {
        return session;
      }
    }
  }
  const candidates = [...sessions];
  return candidates.length === 1 ? candidates[0] : undefined;
}

export class AcpNativeAgent implements Agent {
  private readonly executeAgent: AgentExecutor;
  private readonly createId: () => string;
  private readonly subscribeAgentEvents: typeof onAgentEvent;
  private readonly resolveAgentId: () => string;
  private readonly runtime: RuntimeEnv;
  private readonly sessionCreateRateLimiter: FixedWindowRateLimiter;
  private readonly abortSettleTimeoutMs: number;
  private readonly sessions = new Map<string, NativeSession>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly admittedPrompts = new Map<string, Set<Promise<PromptResponse>>>();
  private readonly closingSessions = new Set<string>();
  private readonly pluginApprovalBroker = new EmbeddedPluginApprovalBroker();
  private unsubscribePluginApprovals?: () => void;
  private started = false;
  private stopping = false;

  constructor(
    private readonly connection: AgentSideConnection,
    deps: NativeAgentDependencies = {},
  ) {
    this.executeAgent = deps.executeAgent ?? agentCommandFromIngress;
    this.createId = deps.createId ?? randomUUID;
    this.subscribeAgentEvents = deps.subscribeAgentEvents ?? onAgentEvent;
    this.resolveAgentId = deps.resolveAgentId ?? (() => resolveDefaultAgentId(getRuntimeConfig()));
    this.runtime = deps.runtime ?? silentRuntime;
    this.abortSettleTimeoutMs = deps.abortSettleTimeoutMs ?? resolveEmbeddedAbortSettleTimeoutMs();
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: resolveFixedWindowRateLimitInteger(
        deps.sessionCreateRateLimit?.maxRequests,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
        { min: 1 },
      ),
      windowMs: resolveFixedWindowRateLimitInteger(
        deps.sessionCreateRateLimit?.windowMs,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
        { min: 1_000 },
      ),
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    setEmbeddedMode(true);
    setEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    this.unsubscribePluginApprovals = this.pluginApprovalBroker.subscribe((event) => {
      if (event.event !== "plugin.approval.requested") {
        return;
      }
      void this.relayPluginApproval(event.payload);
    });
  }

  initialize(params: InitializeRequest): InitializeResponse {
    const terminalAuth = params.clientCapabilities?.auth?.terminal === true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          close: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: terminalAuth
        ? [
            {
              id: "openclaw-model-setup",
              name: "Configure OpenClaw model",
              description: "Authenticate a model provider and choose OpenClaw model defaults.",
              type: "terminal",
              args: ["--configure-model"],
            },
          ]
        : [],
    };
  }

  authenticate(params: AuthenticateRequest): AuthenticateResponse {
    if (params.methodId !== "openclaw-model-setup") {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `authentication method "${params.methodId}" is not supported`,
      );
    }
    return {};
  }

  newSession(params: NewSessionRequest): NewSessionResponse {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({ cwd: params.cwd }, "cwd must be an absolute path");
    }
    if (params.mcpServers.length > 0) {
      throw RequestError.invalidParams(
        { mcpServers: params.mcpServers },
        "client-supplied MCP servers are not supported",
      );
    }
    if ((params.additionalDirectories?.length ?? 0) > 0) {
      throw RequestError.invalidParams(
        { additionalDirectories: params.additionalDirectories },
        "additional directories are not supported",
      );
    }
    const budget = this.sessionCreateRateLimiter.consume();
    if (!budget.allowed) {
      throw new Error(
        `ACP session creation rate limit exceeded for newSession; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
      );
    }
    const id = this.createId();
    const agentId = this.resolveAgentId();
    const session: NativeSession = {
      id,
      key: buildNativeSessionKey({ agentId, sessionId: id }),
      cwd: params.cwd,
      promptGeneration: 0,
    };
    this.sessions.set(id, session);
    return { sessionId: id };
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    const completion = this.runAdmittedPrompt(params).catch((error: unknown) => {
      throw toAcpPromptRequestError(error);
    });
    const admitted = this.admittedPrompts.get(params.sessionId) ?? new Set();
    admitted.add(completion);
    this.admittedPrompts.set(params.sessionId, admitted);
    const release = () => {
      admitted.delete(completion);
      if (admitted.size === 0) {
        this.admittedPrompts.delete(params.sessionId);
      }
    };
    void completion.then(release, release);
    return completion;
  }

  private async runAdmittedPrompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.stopping) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        "ACP agent is shutting down",
      );
    }
    const session = this.sessions.get(params.sessionId);
    if (!session || this.closingSessions.has(params.sessionId)) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown ACP session "${params.sessionId}"`,
      );
    }
    const promptGeneration = ++session.promptGeneration;
    const previous = this.activeTurns.get(session.id);
    if (previous) {
      previous.controller.abort(new Error("ACP prompt superseded"));
      const settled = await this.waitForPromptCompletions([previous.completion], session.id);
      if (!settled) {
        return { stopReason: "cancelled" };
      }
    }
    // Waiting prompts are admitted work but are not active turns yet. Recheck
    // teardown and supersession fences before they can touch runtime state.
    if (
      this.stopping ||
      this.closingSessions.has(session.id) ||
      this.sessions.get(session.id) !== session
    ) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown ACP session "${params.sessionId}"`,
      );
    }
    if (session.promptGeneration !== promptGeneration) {
      return { stopReason: "cancelled" };
    }

    const controller = new AbortController();
    const runId = this.createId();
    const completion = this.runPrompt(session, params, controller, runId, promptGeneration);
    this.activeTurns.set(session.id, { runId, controller, completion });
    try {
      return await completion;
    } finally {
      if (this.activeTurns.get(session.id)?.completion === completion) {
        this.activeTurns.delete(session.id);
      }
    }
  }

  cancel(params: CancelNotification): void {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.promptGeneration += 1;
    }
    this.activeTurns.get(params.sessionId)?.controller.abort(new Error("ACP prompt cancelled"));
  }

  private collectAdmittedPrompts(sessionId?: string): Promise<PromptResponse>[] {
    const completions: Promise<PromptResponse>[] = [];
    const groups = sessionId
      ? [this.admittedPrompts.get(sessionId)].filter(
          (group): group is Set<Promise<PromptResponse>> => group !== undefined,
        )
      : this.admittedPrompts.values();
    for (const group of groups) {
      for (const completion of group) {
        completions.push(completion);
      }
    }
    return completions;
  }

  private async waitForAdmittedPrompts(sessionId?: string): Promise<void> {
    const completions = this.collectAdmittedPrompts(sessionId);
    await this.waitForPromptCompletions(completions, sessionId);
  }

  private async waitForPromptCompletions(
    completions: Promise<PromptResponse>[],
    sessionId?: string,
  ): Promise<boolean> {
    if (completions.length === 0) {
      return true;
    }
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.allSettled(completions).then(() => "settled" as const),
      new Promise<"timed_out">((resolve) => {
        timeout = setTimeout(() => resolve("timed_out"), this.abortSettleTimeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome === "timed_out") {
      this.runtime.error(
        `ACP native abort settle timed out after ${this.abortSettleTimeoutMs}ms` +
          (sessionId ? ` for session ${sessionId}` : ""),
      );
    }
    return outcome === "settled";
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.closingSessions.add(params.sessionId);
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.promptGeneration += 1;
    }
    try {
      this.activeTurns.get(params.sessionId)?.controller.abort(new Error("ACP session closed"));
      await this.waitForAdmittedPrompts(params.sessionId);
      this.activeTurns.delete(params.sessionId);
      this.admittedPrompts.delete(params.sessionId);
      this.sessions.delete(params.sessionId);
      return {};
    } finally {
      this.closingSessions.delete(params.sessionId);
    }
  }

  async shutdown(reason: unknown = new Error("ACP agent stopped")): Promise<void> {
    this.stopping = true;
    for (const session of this.sessions.values()) {
      session.promptGeneration += 1;
    }
    for (const turn of this.activeTurns.values()) {
      turn.controller.abort(reason);
    }
    await this.waitForAdmittedPrompts();
    this.activeTurns.clear();
    this.admittedPrompts.clear();
    this.closingSessions.clear();
    this.sessions.clear();
    clearEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    this.unsubscribePluginApprovals?.();
    this.unsubscribePluginApprovals = undefined;
    this.pluginApprovalBroker.stop(reason);
    setEmbeddedMode(false);
    this.started = false;
  }

  private async runPrompt(
    session: NativeSession,
    params: PromptRequest,
    controller: AbortController,
    runId: string,
    promptGeneration: number,
  ): Promise<PromptResponse> {
    const text = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    const decodedImageBytes = attachments.reduce(
      (total, attachment) => total + Buffer.byteLength(attachment.content, "base64"),
      0,
    );
    if (Buffer.byteLength(text, "utf8") + decodedImageBytes > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }

    let sentThought = "";
    let updateTail = Promise.resolve();
    const isPromptCurrent = () =>
      !controller.signal.aborted &&
      !this.stopping &&
      !this.closingSessions.has(session.id) &&
      this.sessions.get(session.id) === session &&
      session.promptGeneration === promptGeneration;
    const enqueueUpdate = (
      update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"],
    ) => {
      updateTail = updateTail.then(async () => {
        if (isPromptCurrent()) {
          await this.connection.sessionUpdate({ sessionId: session.id, update });
        }
      });
    };
    const unsubscribe = this.subscribeAgentEvents((event) => {
      if (event.runId !== runId || !isPromptCurrent()) {
        return;
      }
      const projected = this.projectThoughtEvent(event, sentThought);
      if (!projected) {
        return;
      }
      sentThought += projected;
      enqueueUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: projected },
      });
    });

    let result: AgentResult | undefined;
    try {
      result = await this.executeAgent(
        {
          message: text,
          transcriptMessage: text,
          images: attachments.map((attachment) => ({
            type: "image" as const,
            data: attachment.content,
            mimeType: attachment.mimeType,
          })),
          sessionKey: session.key,
          cwd: session.cwd,
          deliver: false,
          channel: INTERNAL_MESSAGE_CHANNEL,
          messageChannel: INTERNAL_MESSAGE_CHANNEL,
          messageProvider: INTERNAL_MESSAGE_CHANNEL,
          runContext: {
            messageChannel: INTERNAL_MESSAGE_CHANNEL,
            currentChannelId: INTERNAL_MESSAGE_CHANNEL,
          },
          runId,
          abortSignal: controller.signal,
          allowModelOverride: false,
          senderIsOwner: false,
          localExecApprovalHandler: async (request, signal) =>
            await this.requestExecApproval(session.id, request, signal),
          inputProvenance: {
            kind: "external_user",
            sourceChannel: "acp",
          },
        },
        this.runtime,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      unsubscribe();
      await updateTail;
    }

    if (controller.signal.aborted) {
      return { stopReason: "cancelled" };
    }
    const resultError = agentResultError(result);
    if (resultError) {
      throw resultError;
    }
    const finalText = finalVisibleText(result);
    if (finalText) {
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: finalText },
        },
      });
    }
    return { stopReason: "end_turn" };
  }

  private projectThoughtEvent(event: AgentEventPayload, sentThought: string): string | undefined {
    if (event.stream !== "thinking") {
      return undefined;
    }
    const data = event.data as { delta?: unknown; text?: unknown };
    if (typeof data.delta === "string" && data.delta) {
      return data.delta;
    }
    if (typeof data.text !== "string") {
      return undefined;
    }
    if (!data.text.startsWith(sentThought) || data.text.length <= sentThought.length) {
      return undefined;
    }
    return data.text.slice(sentThought.length);
  }

  private async requestExecApproval(
    sessionId: string,
    request: LocalExecApprovalRequest,
    signal: AbortSignal,
  ): Promise<ExecApprovalDecision | null> {
    const permission = buildAcpPermissionRequest({
      sessionId,
      event: {
        approvalId: request.id,
        command: request.commandPreview ?? request.command,
        host: request.host,
        toolCallId: request.toolCallId,
      },
      details: {
        allowedDecisions: request.allowedDecisions,
        commandText: request.command,
        commandPreview: request.commandPreview,
        host: request.host,
      },
    });
    const response = await requestPermissionWithSignal({
      connection: this.connection,
      request: permission,
      signal,
    });
    return resolveGatewayDecisionFromPermissionOutcome(response, permission.options) ?? "deny";
  }

  private async relayPluginApproval(approval: EmbeddedPluginApprovalRequest): Promise<void> {
    const session = resolveSessionForPluginApproval(this.sessions.values(), approval.request);
    if (!session) {
      this.pluginApprovalBroker.resolve(approval.id, "deny");
      return;
    }
    const activeTurn = this.activeTurns.get(session.id);
    if (!activeTurn || !approval.runId || approval.runId !== activeTurn.runId) {
      this.pluginApprovalBroker.resolve(approval.id, "deny");
      return;
    }
    const permission = pluginPermissionRequest(session.id, approval);
    if (!permission) {
      this.pluginApprovalBroker.resolve(approval.id, "deny");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Plugin approval "${approval.id}" expired`)),
      Math.max(1, approval.expiresAtMs - Date.now()),
    );
    timeout.unref?.();
    const onAbort = () => controller.abort(activeTurn.controller.signal.reason);
    activeTurn.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (activeTurn.controller.signal.aborted) {
      onAbort();
    }
    try {
      const response = await requestPermissionWithSignal({
        connection: this.connection,
        request: permission,
        signal: controller.signal,
      });
      const decision =
        resolveGatewayDecisionFromPermissionOutcome(response, permission.options) ?? "deny";
      this.pluginApprovalBroker.resolve(approval.id, decision);
    } finally {
      clearTimeout(timeout);
      activeTurn.controller.signal.removeEventListener("abort", onAbort);
    }
  }
}
