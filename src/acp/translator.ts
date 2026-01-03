/**
 * ACP-GW Translator
 *
 * Implements ACP Agent interface, translating to Gateway RPC calls.
 */

import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  ImageContent,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  TextContent,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import type { EventFrame } from "../gateway/protocol/index.js";

// ACP StopReason type (inlined to avoid subpath import issues)
type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
import { GatewayClient } from "../gateway/client.js";
import {
  cancelActiveRun,
  clearActiveRun,
  createSession,
  getSession,
  getSessionByRunId,
  setActiveRun,
} from "./session.js";
import { ACP_GW_AGENT_INFO, type AcpGwOptions } from "./types.js";

/**
 * Gateway-backed ACP Agent.
 */
export class AcpGwAgent implements Agent {
  private connection: AgentSideConnection;
  private gateway: GatewayClient;
  private opts: AcpGwOptions;
  private log: (msg: string) => void;
  private connected = false;
  private pendingPrompts = new Map<
    string,
    {
      sessionId: string;
      idempotencyKey: string;
      resolve: (response: PromptResponse) => void;
      reject: (err: Error) => void;
      sentTextLength?: number; // Track cumulative text length for delta diffing
      sentText?: string; // Track actual sent text for duplicate detection
    }
  >();

  constructor(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpGwOptions = {},
  ) {
    this.connection = connection;
    this.gateway = gateway;
    this.opts = opts;
    this.log = opts.verbose
      ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`)
      : () => {};
  }

  /**
   * Start listening for Gateway events.
   */
  start(): void {
    // Gateway client already started; we handle events via onEvent callback
    this.connected = true;
    this.log("translator started");
  }

  /**
   * Update the Gateway client (used for reconnection).
   */
  updateGateway(gateway: GatewayClient): void {
    this.gateway = gateway;
    this.log("gateway client updated");
  }

  /**
   * Handle Gateway reconnect.
   */
  handleGatewayReconnect(): void {
    this.connected = true;
    this.log("gateway reconnected");
  }

  /**
   * Handle Gateway disconnect — reject all pending prompts.
   */
  handleGatewayDisconnect(reason: string): void {
    this.connected = false;
    this.log(`gateway disconnected: ${reason}`);
    
    // Reject all pending prompts
    for (const [sessionId, pending] of this.pendingPrompts) {
      this.log(`rejecting pending prompt for session ${sessionId}`);
      pending.reject(new Error(`Gateway disconnected: ${reason}`));
      clearActiveRun(sessionId);
    }
    this.pendingPrompts.clear();
  }

  /**
   * Handle Gateway events, mapping to ACP session updates.
   */
  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    this.log(`event: ${evt.event} payload=${JSON.stringify(evt.payload).slice(0, 200)}`);
    
    // Agent events contain streaming data
    if (evt.event === "agent") {
      await this.handleAgentEvent(evt);
    }
    // Chat events contain state changes
    if (evt.event === "chat") {
      await this.handleChatEvent(evt);
    }
  }

  private async handleAgentEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const runId = payload.runId as string | undefined;
    const stream = payload.stream as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;

    if (!runId || !data) return;

    // Find session by runId
    const session = getSessionByRunId(runId);
    if (!session) return;

    // Handle tool events
    if (stream === "tool") {
      const phase = data.phase as string | undefined;
      const name = data.name as string | undefined;
      const toolCallId = data.toolCallId as string | undefined;

      if (!toolCallId) return;

      if (phase === "start") {
        // Tool call started
        await this.connection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: name ?? "tool",
            status: "running",
          },
        });
      } else if (phase === "result") {
        // Tool call completed
        const isError = data.isError as boolean | undefined;
        await this.connection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "error" : "completed",
          },
        });
      }
    }
  }

  private async handleChatEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const sessionKey = payload.sessionKey as string | undefined;
    const state = payload.state as string | undefined;
    const messageData = payload.message as Record<string, unknown> | undefined;
    
    this.log(`handleChatEvent: sessionKey=${sessionKey} state=${state}`);
    
    if (!sessionKey) return;

    // Find the pending prompt for this sessionKey
    const pending = this.findPendingBySessionKey(sessionKey);
    if (!pending) {
      this.log(`handleChatEvent: no pending for sessionKey=${sessionKey}`);
      return;
    }
    
    const { sessionId } = pending;

    // Handle streaming text (delta state)
    // Gateway sends cumulative text, so we track what we've sent and only send the diff
    if (state === "delta" && messageData) {
      const content = messageData.content as Array<{type: string; text?: string}> | undefined;
      const fullText = content?.find(c => c.type === "text")?.text ?? "";
      // Get the actual pending from the map to ensure we're modifying the right object
      const actualPending = this.pendingPrompts.get(sessionId);
      const sentSoFar = actualPending?.sentTextLength ?? 0;
      const sentText = actualPending?.sentText ?? "";
      
      if (fullText.length > sentSoFar && actualPending) {
        const newText = fullText.slice(sentSoFar);
        
        // Workaround: Gateway sometimes sends duplicated text (full response appears twice)
        // Detect if the "new" text is actually a repeat of what we already sent
        if (sentText.length > 0 && newText.startsWith(sentText.slice(0, Math.min(20, sentText.length)))) {
          this.log(`skipping duplicate: newText starts with already-sent content`);
          return;
        }
        
        actualPending.sentTextLength = fullText.length;
        actualPending.sentText = fullText;
        this.log(`streaming delta: +${newText.length} chars`);
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: newText },
          },
        });
      }
      return;
    }

    if (state === "final" || state === "done" || state === "error" || state === "aborted") {
      // Prompt completed
      this.log(`chat completed: state=${state} sessionId=${sessionId}`);
      this.pendingPrompts.delete(sessionId);
      clearActiveRun(sessionId);

      // Map state to ACP StopReason (error maps to refusal since ACP doesn't have "error")
      const stopReason: StopReason =
        state === "final" || state === "done"
          ? "end_turn"
          : state === "aborted"
            ? "cancelled"
            : "refusal";

      pending.resolve({ stopReason });
    }
  }

  private findPendingBySessionKey(
    sessionKey: string,
  ): { sessionId: string; resolve: (r: PromptResponse) => void; sentTextLength?: number } | undefined {
    this.log(`findPending: looking for sessionKey=${sessionKey}, pendingCount=${this.pendingPrompts.size}`);
    for (const [sessionId, pending] of this.pendingPrompts) {
      const session = getSession(sessionId);
      this.log(`  checking sessionId=${sessionId} -> session.sessionKey=${session?.sessionKey}`);
      if (session?.sessionKey === sessionKey) {
        return pending;
      }
    }
    return undefined;
  }

  /**
   * Initialize the agent.
   */
  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.log("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
      },
      agentInfo: ACP_GW_AGENT_INFO,
      authMethods: [],
    };
  }

  /**
   * Create a new session.
   */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const session = createSession(params.cwd);
    this.log(`newSession: ${session.sessionId} (cwd: ${params.cwd})`);
    return { sessionId: session.sessionId };
  }

  /**
   * Handle authentication (no-op).
   */
  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | undefined> {
    return {};
  }

  /**
   * Handle session mode changes.
   */
  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    // Map ACP modeId to thinking level if applicable
    const modeId = params.modeId;
    if (modeId) {
      try {
        await this.gateway.request("sessions.patch", {
          sessionKey: session.sessionKey,
          thinkingLevel: modeId,
        });
        this.log(`setSessionMode: ${session.sessionId} -> ${modeId}`);
      } catch (err) {
        this.log(`setSessionMode error: ${String(err)}`);
      }
    }

    return {};
  }

  /**
   * Handle a prompt request.
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    // Cancel any existing prompt
    if (session.abortController) {
      cancelActiveRun(params.sessionId);
    }

    const abortController = new AbortController();
    const runId = crypto.randomUUID();
    setActiveRun(params.sessionId, runId, abortController);

    const userText = this.extractTextFromPrompt(params.prompt);
    const attachments = this.extractAttachmentsFromPrompt(params.prompt);
    
    // Prepend working directory context
    const cwdContext = `[Working directory: ${session.cwd}]\n\n`;
    const message = cwdContext + userText;

    this.log(`prompt: ${session.sessionId} -> "${userText.slice(0, 50)}..." (${attachments.length} attachments)`);

    return new Promise<PromptResponse>((resolve, reject) => {
      this.pendingPrompts.set(params.sessionId, {
        sessionId: params.sessionId,
        idempotencyKey: runId,
        resolve,
        reject,
      });

      // Send to Gateway
      this.gateway
        .request(
          "chat.send",
          {
            sessionKey: session.sessionKey,
            message,
            attachments: attachments.length > 0 ? attachments : undefined,
            idempotencyKey: runId,
          },
          { expectFinal: true },
        )
        .catch((err) => {
          this.pendingPrompts.delete(params.sessionId);
          clearActiveRun(params.sessionId);
          reject(err);
        });
    });
  }

  /**
   * Cancel an in-progress prompt.
   */
  async cancel(params: CancelNotification): Promise<void> {
    const session = getSession(params.sessionId);
    if (!session) return;

    this.log(`cancel: ${params.sessionId}`);

    cancelActiveRun(params.sessionId);

    try {
      await this.gateway.request("chat.abort", {
        sessionKey: session.sessionKey,
      });
    } catch (err) {
      this.log(`cancel error: ${String(err)}`);
    }

    // Resolve pending promise as cancelled
    const pending = this.pendingPrompts.get(params.sessionId);
    if (pending) {
      this.pendingPrompts.delete(params.sessionId);
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  /**
   * Load a persisted session (not implemented).
   */
  async loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    throw new Error("Session loading not implemented");
  }

  /**
   * Extract text from ACP prompt content blocks.
   */
  private extractTextFromPrompt(prompt: ContentBlock[]): string {
    return prompt
      .filter(
        (block): block is TextContent & { type: "text" } =>
          "type" in block && block.type === "text" && "text" in block,
      )
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * Extract image attachments from ACP prompt content blocks.
   */
  private extractAttachmentsFromPrompt(
    prompt: ContentBlock[],
  ): Array<{ type: string; mimeType: string; content: string }> {
    const attachments: Array<{ type: string; mimeType: string; content: string }> = [];
    
    for (const block of prompt) {
      if ("type" in block && block.type === "image") {
        const imageBlock = block as ImageContent & { type: "image" };
        if (imageBlock.data && imageBlock.mimeType) {
          attachments.push({
            type: "image",
            mimeType: imageBlock.mimeType,
            content: imageBlock.data, // Already base64 encoded
          });
        }
      }
    }
    
    return attachments;
  }
}
