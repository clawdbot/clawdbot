/** Agent Client Protocol bridge that translates ACP sessions/prompts to Gateway chat sessions. */
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { defaultAcpSessionStore, type AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  createFixedWindowBudget,
  resolveFixedWindowRateLimitInteger,
} from "../infra/fixed-window-rate-limit.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createInMemoryAcpEventLedger, type AcpEventLedger } from "./event-ledger.js";
import type { AcpPendingApprovalRelay } from "./translator.prompt-state.js";
import { AcpTranslatorPromptStream } from "./translator.prompt-stream.js";
import { AcpTranslatorSessionLifecycle } from "./translator.session-lifecycle.js";
import { AcpTranslatorSessionState } from "./translator.session-state.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";
import { ACP_AGENT_INFO } from "./types.js";

const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

const loadAcpCommandsModule = createLazyRuntimeModule(() => import("./commands.js"));
const loadAcpSdkModule = createLazyRuntimeModule(() => import("@agentclientprotocol/sdk"));

async function getAvailableCommandsForAcp() {
  const { getAvailableCommands } = await loadAcpCommandsModule();
  return getAvailableCommands();
}

type AcpGatewayAgentOptions = AcpServerOptions & {
  eventLedger?: AcpEventLedger;
  sessionStore?: AcpSessionStore;
};

/** ACP Agent implementation backed by the OpenClaw Gateway and replay ledger. */
export class AcpGatewayAgent implements Agent {
  private readonly sessionUpdates: AcpTranslatorSessionUpdates;
  private readonly promptStream: AcpTranslatorPromptStream;
  private readonly sessionLifecycle: AcpTranslatorSessionLifecycle;
  private readonly approvalRelays = new Map<string, AcpPendingApprovalRelay>();
  private readonly log: (msg: string) => void;

  constructor(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpGatewayAgentOptions = {},
  ) {
    this.log = opts.verbose ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
    const sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
    this.sessionUpdates = new AcpTranslatorSessionUpdates({
      connection,
      eventLedger: opts.eventLedger ?? createInMemoryAcpEventLedger(),
      getAvailableCommands: getAvailableCommandsForAcp,
      log: this.log,
    });
    const sessionState = new AcpTranslatorSessionState(gateway, this.sessionUpdates, this.log);
    this.promptStream = new AcpTranslatorPromptStream(
      connection,
      gateway,
      opts,
      sessionStore,
      this.sessionUpdates,
      sessionState,
      this.approvalRelays,
      this.log,
    );
    const sessionCreateRateLimiter = createFixedWindowBudget({
      maxRequests: resolveFixedWindowRateLimitInteger(
        opts.sessionCreateRateLimit?.maxRequests,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
        { min: 1 },
      ),
      windowMs: resolveFixedWindowRateLimitInteger(
        opts.sessionCreateRateLimit?.windowMs,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
        { min: 1_000 },
      ),
    });
    this.sessionLifecycle = new AcpTranslatorSessionLifecycle(
      gateway,
      opts,
      sessionStore,
      this.sessionUpdates,
      sessionState,
      sessionCreateRateLimiter,
      (session) => this.promptStream.cancelSessionWork(session),
      this.log,
    );
  }

  start(): void {
    this.log("ready");
  }

  shutdown(): void {
    this.sessionUpdates.stop();
    this.promptStream.shutdown();
  }

  handleGatewayReconnect(): void {
    this.promptStream.handleGatewayReconnect();
  }

  handleGatewayDisconnect(reason: string): void {
    this.promptStream.handleGatewayDisconnect(reason);
  }

  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    await this.promptStream.handleGatewayEvent(evt);
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: (await loadAcpSdkModule()).PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
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
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return await this.sessionLifecycle.newSession(params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return await this.sessionLifecycle.loadSession(params);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return await this.sessionLifecycle.listSessions(params);
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return await this.sessionLifecycle.resumeSession(params);
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return await this.sessionLifecycle.closeSession(params);
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return await this.sessionLifecycle.authenticate(params);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return await this.sessionLifecycle.setSessionMode(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return await this.sessionLifecycle.setSessionConfigOption(params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return await this.promptStream.prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.promptStream.cancel(params);
  }
}
