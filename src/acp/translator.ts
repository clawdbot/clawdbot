import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
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
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { BASE_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.js";
import {
  createFixedWindowRateLimiter,
  type FixedWindowRateLimiter,
} from "../infra/fixed-window-rate-limit.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { shortenHomePath } from "../utils.js";
import {
  createInMemoryAcpEventLedger,
  type AcpEventLedger,
  type AcpEventLedgerReplay,
} from "./event-ledger.js";
import {
  extractAttachmentsFromPrompt,
  extractToolCallContent,
  extractToolCallLocations,
  extractTextFromPrompt,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
import { readBool, readNumber, readString } from "./meta.js";
import {
  buildAcpPermissionRequest,
  parseGatewayExecApprovalEventData,
  parseGatewayExecApprovalRequestEventPayload,
  resolveGatewayDecisionFromPermissionOutcome,
  type GatewayExecApprovalDecision,
  type GatewayExecApprovalDetails,
  type GatewayExecApprovalEvent,
} from "./permission-relay.js";
import { toAcpSessionLineageMeta, type AcpSessionLineageMeta } from "./session-lineage-meta.js";
import { parseSessionMeta, resetSessionIfNeeded, resolveSessionKey } from "./session-mapper.js";
import { defaultAcpSessionStore, type AcpSessionStore } from "./session.js";
import { ACP_AGENT_INFO, type AcpServerOptions } from "./types.js";

// Maximum allowed prompt size (2MB) to prevent DoS via memory exhaustion (CWE-400, GHSA-cxpw-2g23-2vgw)
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const ACP_FAST_MODE_CONFIG_ID = "fast_mode";
const ACP_VERBOSE_LEVEL_CONFIG_ID = "verbose_level";
const ACP_TRACE_LEVEL_CONFIG_ID = "trace_level";
const ACP_REASONING_LEVEL_CONFIG_ID = "reasoning_level";
const ACP_RESPONSE_USAGE_CONFIG_ID = "response_usage";
const ACP_ELEVATED_LEVEL_CONFIG_ID = "elevated_level";
const ACP_TIMEOUT_CONFIG_ID = "timeout";
const ACP_TIMEOUT_SECONDS_CONFIG_ID = "timeout_seconds";
const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;
const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5_000;
const ACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET = 10_000;
const ACP_LIST_SESSIONS_MAX_FETCH_LIMIT =
  ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET + ACP_LIST_SESSIONS_MAX_PAGE_SIZE + 1;

let acpCommandsModulePromise: Promise<typeof import("./commands.js")> | undefined;
let acpSdkModulePromise: Promise<typeof import("@agentclientprotocol/sdk")> | undefined;

async function getAvailableCommandsForAcp() {
  acpCommandsModulePromise ??= import("./commands.js");
  const { getAvailableCommands } = await acpCommandsModulePromise;
  return getAvailableCommands();
}

async function getAcpProtocolVersion() {
  acpSdkModulePromise ??= import("@agentclientprotocol/sdk");
  const { PROTOCOL_VERSION } = await acpSdkModulePromise;
  return PROTOCOL_VERSION;
}

type DisconnectContext = {
  generation: number;
  reason: string;
};

type PendingPrompt = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  idempotencyKey: string;
  sendAccepted?: boolean;
  disconnectContext?: DisconnectContext;
  resolve: (response: PromptResponse) => void;
  reject: (err: Error) => void;
  sentTextLength?: number;
  sentText?: string;
  sentThoughtLength?: number;
  sentThought?: string;
  toolCalls?: Map<string, PendingToolCall>;
};

type ClientCapabilityState = {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
};

type PendingApprovalRelay = {
  approvalId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  state: "active" | "completed";
};

type PendingToolCall = {
  kind: ToolKind;
  locations?: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
  title: string;
};

type AcpGatewayAgentOptions = AcpServerOptions & {
  eventLedger?: AcpEventLedger;
  sessionStore?: AcpSessionStore;
};

type GatewaySessionPresentationRow = Pick<
  GatewaySessionRow,
  | "key"
  | "kind"
  | "channel"
  | "parentSessionKey"
  | "spawnedBy"
  | "spawnDepth"
  | "subagentRole"
  | "subagentControlScope"
  | "spawnedWorkspaceDir"
  | "displayName"
  | "label"
  | "derivedTitle"
  | "updatedAt"
  | "thinkingLevel"
  | "fastMode"
  | "modelProvider"
  | "model"
  | "thinkingLevels"
  | "verboseLevel"
  | "traceLevel"
  | "reasoningLevel"
  | "responseUsage"
  | "elevatedLevel"
  | "totalTokens"
  | "totalTokensFresh"
  | "contextTokens"
>;

type SessionPresentation = {
  configOptions: SessionConfigOption[];
  modes: SessionModeState;
};

type SessionMetadata = {
  title?: string | null;
  updatedAt?: string | null;
  _meta?: AcpSessionLineageMeta;
};

type SessionUsageSnapshot = {
  size: number;
  used: number;
};

function normalizeClientCapabilities(
  capabilities: InitializeRequest["clientCapabilities"] | undefined,
): ClientCapabilityState {
  return {
    readTextFile: capabilities?.fs?.readTextFile === true,
    writeTextFile: capabilities?.fs?.writeTextFile === true,
    terminal: capabilities?.terminal === true,
  };
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
  return err instanceof Error && err.message.startsWith("gateway closed (");
}

type SessionSnapshot = SessionPresentation & {
  metadata?: SessionMetadata;
  usage?: SessionUsageSnapshot;
};

type AgentWaitResult = {
  status?: "ok" | "error" | "timeout";
  error?: string;
};

type GatewayTranscriptMessage = {
  role?: unknown;
  content?: unknown;
};

type GatewayChatContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type ReplayChunk = {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  text: string;
};

type ListSessionsCursor = {
  offset: number;
  cwd?: string;
};

function encodeListSessionsCursor(cursor: ListSessionsCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeListSessionsCursor(value: string | null | undefined): ListSessionsCursor {
  if (!value) {
    return { offset: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid ACP session list cursor.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid ACP session list cursor.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) {
    throw new Error("Unsupported ACP session list cursor.");
  }
  if (
    typeof record.offset !== "number" ||
    !Number.isInteger(record.offset) ||
    record.offset < 0 ||
    record.offset > ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET
  ) {
    throw new Error("Invalid ACP session list cursor offset.");
  }
  const cwd = normalizeOptionalString(record.cwd);
  return {
    offset: record.offset,
    ...(cwd ? { cwd } : {}),
  };
}

function assertAbsoluteCwd(cwd: string, method: string): void {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`ACP ${method} requires an absolute cwd.`);
  }
}

function resolveListSessionsPageSize(meta: Record<string, unknown> | null | undefined): number {
  const requested = readNumber(meta, ["limit", "pageSize"]);
  if (requested === undefined) {
    return ACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE;
  }
  return Math.min(ACP_LIST_SESSIONS_MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}

const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

function formatThinkingLevelName(level: string): string {
  switch (level) {
    case "xhigh":
      return "Extra High";
    case "adaptive":
      return "Adaptive";
    default:
      return level.length > 0 ? `${level[0].toUpperCase()}${level.slice(1)}` : "Unknown";
  }
}

function buildThinkingModeDescription(level: string): string | undefined {
  if (level === "adaptive") {
    return "Use the Gateway session default thought level.";
  }
  return undefined;
}

function formatConfigValueName(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    default:
      return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : "Unknown";
  }
}

function buildSelectConfigOption(params: {
  id: string;
  name: string;
  description: string;
  currentValue: string;
  values: readonly string[];
  category?: string;
}): SessionConfigOption {
  return {
    type: "select",
    id: params.id,
    name: params.name,
    category: params.category,
    description: params.description,
    currentValue: params.currentValue,
    options: params.values.map((value) => ({
      value,
      name: formatConfigValueName(value),
    })),
  };
}

function buildSessionPresentation(params: {
  row?: GatewaySessionPresentationRow;
  overrides?: Partial<GatewaySessionPresentationRow>;
}): SessionPresentation {
  const row = {
    ...params.row,
    ...params.overrides,
  };
  const availableLevelIds: string[] = row.thinkingLevels?.map((level) => level.id) ?? [
    ...BASE_THINKING_LEVELS,
  ];
  const currentModeId = normalizeOptionalString(row.thinkingLevel) || "adaptive";
  if (!availableLevelIds.includes(currentModeId)) {
    availableLevelIds.push(currentModeId);
  }

  const modes: SessionModeState = {
    currentModeId,
    availableModes: availableLevelIds.map((level) => ({
      id: level,
      name: formatThinkingLevelName(level),
      description: buildThinkingModeDescription(level),
    })),
  };

  const configOptions: SessionConfigOption[] = [
    buildSelectConfigOption({
      id: ACP_THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought level",
      category: "thought_level",
      description:
        "Controls how much deliberate reasoning OpenClaw requests from the Gateway model.",
      currentValue: currentModeId,
      values: availableLevelIds,
    }),
    buildSelectConfigOption({
      id: ACP_FAST_MODE_CONFIG_ID,
      name: "Fast mode",
      description: "Controls whether OpenAI sessions use the Gateway fast-mode profile.",
      currentValue: row.fastMode ? "on" : "off",
      values: ["off", "on"],
    }),
    buildSelectConfigOption({
      id: ACP_VERBOSE_LEVEL_CONFIG_ID,
      name: "Tool verbosity",
      description:
        "Controls how much tool progress and output detail OpenClaw keeps enabled for the session.",
      currentValue: normalizeOptionalString(row.verboseLevel) || "off",
      values: ["off", "on", "full"],
    }),
    buildSelectConfigOption({
      id: ACP_TRACE_LEVEL_CONFIG_ID,
      name: "Plugin trace",
      description: "Controls whether plugin-owned trace lines are shown for the session.",
      currentValue: normalizeOptionalString(row.traceLevel) || "off",
      values: ["off", "on"],
    }),
    buildSelectConfigOption({
      id: ACP_REASONING_LEVEL_CONFIG_ID,
      name: "Reasoning stream",
      description: "Controls whether reasoning-capable models emit reasoning text for the session.",
      currentValue: normalizeOptionalString(row.reasoningLevel) || "off",
      values: ["off", "on", "stream"],
    }),
    buildSelectConfigOption({
      id: ACP_RESPONSE_USAGE_CONFIG_ID,
      name: "Usage detail",
      description:
        "Controls how much usage information OpenClaw attaches to responses for the session.",
      currentValue: normalizeOptionalString(row.responseUsage) || "off",
      values: ["off", "tokens", "full"],
    }),
    buildSelectConfigOption({
      id: ACP_ELEVATED_LEVEL_CONFIG_ID,
      name: "Elevated actions",
      description: "Controls how aggressively the session allows elevated execution behavior.",
      currentValue: normalizeOptionalString(row.elevatedLevel) || "off",
      values: ["off", "on", "ask", "full"],
    }),
  ];

  return { configOptions, modes };
}

function extractReplayChunks(message: GatewayTranscriptMessage): ReplayChunk[] {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  if (typeof message.content === "string") {
    return message.content.length > 0
      ? [
          {
            sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
            text: message.content,
          },
        ]
      : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  const replayChunks: ReplayChunk[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typedBlock = block as GatewayChatContentBlock;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string" && typedBlock.text) {
      replayChunks.push({
        sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
        text: typedBlock.text,
      });
      continue;
    }
    if (
      role === "assistant" &&
      typedBlock.type === "thinking" &&
      typeof typedBlock.thinking === "string" &&
      typedBlock.thinking
    ) {
      replayChunks.push({
        sessionUpdate: "agent_thought_chunk",
        text: typedBlock.thinking,
      });
    }
  }
  return replayChunks;
}

function buildSessionMetadata(params: {
  row?: GatewaySessionPresentationRow;
  sessionKey: string;
}): SessionMetadata {
  const title =
    normalizeOptionalString(params.row?.derivedTitle) ||
    normalizeOptionalString(params.row?.displayName) ||
    normalizeOptionalString(params.row?.label) ||
    params.sessionKey;
  const updatedAt =
    typeof params.row?.updatedAt === "number" && Number.isFinite(params.row.updatedAt)
      ? new Date(params.row.updatedAt).toISOString()
      : null;
  return {
    title,
    updatedAt,
    _meta: toAcpSessionLineageMeta(
      params.row ?? {
        key: params.sessionKey,
        kind: "unknown",
      },
    ),
  };
}

function buildSessionUsageSnapshot(
  row?: GatewaySessionPresentationRow,
): SessionUsageSnapshot | undefined {
  const totalTokens = row?.totalTokens;
  const contextTokens = row?.contextTokens;
  if (
    row?.totalTokensFresh !== true ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return undefined;
  }
  const size = Math.max(0, Math.floor(contextTokens));
  const used = Math.max(0, Math.min(Math.floor(totalTokens), size));
  return { size, used };
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

function hasExplicitSessionRouting(
  meta: ReturnType<typeof parseSessionMeta>,
  opts: AcpServerOptions,
): boolean {
  return Boolean(
    meta.sessionKey || meta.sessionLabel || opts.defaultSessionKey || opts.defaultSessionLabel,
  );
}

function resolveLedgerSessionId(session: { sessionId: string; ledgerSessionId?: string }): string {
  return session.ledgerSessionId ?? session.sessionId;
}

export class AcpGatewayAgent implements Agent {
  private connection: AgentSideConnection;
  private gateway: GatewayClient;
  private opts: AcpGatewayAgentOptions;
  private log: (msg: string) => void;
  private sessionStore: AcpSessionStore;
  private eventLedger: AcpEventLedger;
  private sessionCreateRateLimiter: FixedWindowRateLimiter;
  private pendingPrompts = new Map<string, PendingPrompt>();
  private approvalRelays = new Map<string, PendingApprovalRelay>();
  private clientCapabilities: ClientCapabilityState = normalizeClientCapabilities(undefined);
  private clientInfo: InitializeRequest["clientInfo"] = null;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private activeDisconnectContext: DisconnectContext | null = null;
  private disconnectGeneration = 0;

  private getPendingPrompt(sessionId: string, runId: string): PendingPrompt | undefined {
    const pending = this.pendingPrompts.get(sessionId);
    if (pending?.idempotencyKey !== runId) {
      return undefined;
    }
    return pending;
  }

  constructor(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpGatewayAgentOptions = {},
  ) {
    this.connection = connection;
    this.gateway = gateway;
    this.opts = opts;
    this.log = opts.verbose ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
    this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
    this.eventLedger = opts.eventLedger ?? createInMemoryAcpEventLedger();
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: Math.max(
        1,
        opts.sessionCreateRateLimit?.maxRequests ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
      ),
      windowMs: Math.max(
        1_000,
        opts.sessionCreateRateLimit?.windowMs ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
      ),
    });
  }

  start(): void {
    this.log("ready");
  }

  supportsClientReadTextFile(): boolean {
    return this.clientCapabilities.readTextFile;
  }

  supportsClientWriteTextFile(): boolean {
    return this.clientCapabilities.writeTextFile;
  }

  supportsClientTerminal(): boolean {
    return this.clientCapabilities.terminal;
  }

  getClientInfo(): InitializeRequest["clientInfo"] {
    return this.clientInfo;
  }

  handleGatewayReconnect(): void {
    this.log("gateway reconnected");
    const disconnectContext = this.activeDisconnectContext;
    this.activeDisconnectContext = null;
    if (!disconnectContext) {
      return;
    }
    void this.reconcilePendingPrompts(disconnectContext.generation, false);
  }

  handleGatewayDisconnect(reason: string): void {
    this.log(`gateway disconnected: ${reason}`);
    const disconnectContext = {
      generation: this.disconnectGeneration + 1,
      reason,
    };
    this.disconnectGeneration = disconnectContext.generation;
    this.activeDisconnectContext = disconnectContext;
    if (this.pendingPrompts.size === 0) {
      return;
    }
    for (const pending of this.pendingPrompts.values()) {
      pending.disconnectContext = disconnectContext;
    }
    this.armDisconnectTimer(disconnectContext);
  }

  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    if (evt.event === "chat") {
      await this.handleChatEvent(evt);
      return;
    }
    if (evt.event === "exec.approval.requested") {
      this.handleExecApprovalRequestEvent(evt);
      return;
    }
    if (evt.event === "agent") {
      await this.handleAgentEvent(evt);
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = normalizeClientCapabilities(params.clientCapabilities);
    this.clientInfo = params.clientInfo ?? null;
    return {
      protocolVersion: await getAcpProtocolVersion(),
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
    this.assertSupportedSessionSetup(params.mcpServers);
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params._meta);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: `acp:${sessionId}`,
    });

    const session = this.sessionStore.createSession({
      sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    await this.startLedgerSession(session, { complete: true, reset: true });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey);
    await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: true,
    });
    await this.sendAvailableCommands(session, { record: true });
    const { configOptions, modes } = sessionSnapshot;
    return {
      sessionId: session.sessionId,
      configOptions,
      modes,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    if (!this.sessionStore.hasSession(params.sessionId)) {
      this.enforceSessionCreateRateLimit("loadSession");
    }

    const meta = parseSessionMeta(params._meta);
    const hasExplicitRouting = hasExplicitSessionRouting(meta, this.opts);
    const exactLedgerReplay: AcpEventLedgerReplay = hasExplicitRouting
      ? { complete: false, events: [] }
      : await this.readLedgerReplayBySessionId(params.sessionId);
    const listedLedgerReplay: AcpEventLedgerReplay =
      !hasExplicitRouting && !exactLedgerReplay.complete
        ? await this.readLedgerReplayBySessionKey(params.sessionId)
        : { complete: false, events: [] };
    const routedLedgerReplay = exactLedgerReplay.complete ? exactLedgerReplay : listedLedgerReplay;
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: routedLedgerReplay.sessionKey ?? params.sessionId,
    });
    const ledgerReplay =
      exactLedgerReplay.complete && exactLedgerReplay.sessionKey === sessionKey
        ? exactLedgerReplay
        : listedLedgerReplay.complete && listedLedgerReplay.sessionKey === sessionKey
          ? listedLedgerReplay
          : await this.readLedgerReplay({
              sessionId: params.sessionId,
              sessionKey,
            });

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      ...(ledgerReplay.sessionId ? { ledgerSessionId: ledgerReplay.sessionId } : {}),
      cwd: params.cwd,
    });
    await this.startLedgerSession(session, { complete: ledgerReplay.complete });
    this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
    const [sessionSnapshot, transcript] = await Promise.all([
      this.getSessionSnapshot(session.sessionKey),
      ledgerReplay.complete
        ? Promise.resolve([])
        : this.getSessionTranscript(session.sessionKey).catch((err) => {
            this.log(`session transcript fallback for ${session.sessionKey}: ${String(err)}`);
            return [];
          }),
    ]);
    if (ledgerReplay.complete) {
      await this.replayLedgerSession(session.sessionId, ledgerReplay);
    } else {
      await this.replaySessionTranscript(session.sessionId, transcript);
    }
    await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: false,
    });
    await this.sendAvailableCommands(session, { record: false });
    const { configOptions, modes } = sessionSnapshot;
    return { configOptions, modes };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const requestedCwd = normalizeOptionalString(params.cwd);
    if (requestedCwd) {
      assertAbsoluteCwd(requestedCwd, "session/list");
    }
    const fallbackCwd = requestedCwd ?? process.cwd();
    const rawCursor = normalizeOptionalString(params.cursor);
    const cursor = decodeListSessionsCursor(rawCursor);
    if (rawCursor && cursor.cwd !== requestedCwd) {
      throw new Error("ACP session list cursor does not match the cwd filter.");
    }

    const pageSize = resolveListSessionsPageSize(params._meta);
    const start = cursor.offset;
    const end = start + pageSize;
    let fetchLimit = end + 1;
    let rows: SessionInfo[] = [];

    while (true) {
      const result = await this.gateway.request<SessionsListResult>("sessions.list", {
        limit: fetchLimit,
        includeDerivedTitles: true,
      });
      rows = result.sessions
        .filter((session) => {
          if (!requestedCwd) {
            return true;
          }
          return normalizeOptionalString(session.spawnedWorkspaceDir) === requestedCwd;
        })
        .map((session) => this.mapGatewaySessionToAcpSessionInfo(session, fallbackCwd));
      if (
        rows.length > end ||
        result.hasMore !== true ||
        fetchLimit >= ACP_LIST_SESSIONS_MAX_FETCH_LIMIT
      ) {
        break;
      }
      fetchLimit = Math.min(fetchLimit * 2, ACP_LIST_SESSIONS_MAX_FETCH_LIMIT);
    }

    const page = rows.slice(start, end);
    const hasMore = rows.length > end;
    return {
      sessions: page,
      nextCursor: hasMore
        ? encodeListSessionsCursor({
            offset: end,
            ...(requestedCwd ? { cwd: requestedCwd } : {}),
          })
        : null,
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers ?? []);
    assertAbsoluteCwd(params.cwd, "session/resume");

    const existingSession = this.sessionStore.getSession(params.sessionId);
    if (!existingSession) {
      this.enforceSessionCreateRateLimit("resumeSession");
    }

    const meta = parseSessionMeta(params._meta);
    const fallbackKey = existingSession?.sessionKey ?? params.sessionId;
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey,
    });

    const shouldRequireGatewaySession =
      !existingSession || sessionKey !== existingSession.sessionKey;
    const sessionSnapshot = shouldRequireGatewaySession
      ? await this.getExistingSessionSnapshot(sessionKey)
      : await this.getSessionSnapshot(sessionKey);

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    await this.startLedgerSession(session, { complete: false });
    this.log(`resumeSession: ${session.sessionId} -> ${session.sessionKey}`);
    await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: false,
    });
    await this.sendAvailableCommands(session, { record: false });
    const { configOptions, modes } = sessionSnapshot;
    return { configOptions, modes };
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    await this.cancelSessionWork(session);
    this.sessionStore.deleteSession(params.sessionId);
    this.log(`closeSession: ${params.sessionId}`);
    return {};
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    if (!params.modeId) {
      return {};
    }
    try {
      await this.gateway.request("sessions.patch", {
        key: session.sessionKey,
        thinkingLevel: params.modeId,
      });
      this.log(`setSessionMode: ${session.sessionId} -> ${params.modeId}`);
      const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, {
        thinkingLevel: params.modeId,
      });
      await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
        includeControls: true,
        record: true,
      });
    } catch (err) {
      this.log(`setSessionMode error: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    const sessionPatch = this.resolveSessionConfigPatch(params.configId, params.value);

    try {
      if (sessionPatch.patch) {
        await this.gateway.request("sessions.patch", {
          key: session.sessionKey,
          ...sessionPatch.patch,
        });
      }
      this.log(
        `setSessionConfigOption: ${session.sessionId} -> ${params.configId}=${params.value}`,
      );
      const sessionSnapshot = await this.getSessionSnapshot(
        session.sessionKey,
        sessionPatch.overrides,
      );
      await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
        includeControls: true,
        record: true,
      });
      return {
        configOptions: sessionSnapshot.configOptions,
      };
    } catch (err) {
      this.log(`setSessionConfigOption error: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
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

    const meta = parseSessionMeta(params._meta);
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
      thinking: readString(params._meta, ["thinking", "thinkingLevel"]),
      deliver: readBool(params._meta, ["deliver"]),
      timeoutMs: readNumber(params._meta, ["timeoutMs"]),
    };

    return new Promise<PromptResponse>((resolve, reject) => {
      this.pendingPrompts.set(params.sessionId, {
        sessionId: params.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        idempotencyKey: runId,
        disconnectContext: this.activeDisconnectContext ?? undefined,
        resolve,
        reject,
      });
      if (this.activeDisconnectContext && !this.disconnectTimer) {
        this.armDisconnectTimer(this.activeDisconnectContext);
      }

      const sendWithProvenanceFallback = async () => {
        const markSendAccepted = () => {
          const pending = this.getPendingPrompt(params.sessionId, runId);
          if (pending) {
            pending.sendAccepted = true;
          }
        };
        try {
          await this.gateway.request(
            "chat.send",
            {
              ...requestParams,
              systemInputProvenance,
              systemProvenanceReceipt,
            },
            { timeoutMs: null },
          );
          markSendAccepted();
          await this.recordUserPrompt(session, runId, params.prompt);
        } catch (err) {
          if (
            (systemInputProvenance || systemProvenanceReceipt) &&
            isAdminScopeProvenanceRejection(err)
          ) {
            await this.gateway.request("chat.send", requestParams, { timeoutMs: null });
            markSendAccepted();
            await this.recordUserPrompt(session, runId, params.prompt);
            return;
          }
          throw err;
        }
      };

      void sendWithProvenanceFallback().catch((err) => {
        if (isGatewayCloseError(err) && this.getPendingPrompt(params.sessionId, runId)) {
          return;
        }
        this.clearApprovalRelaysForPrompt(params.sessionId, runId, { denyActive: true });
        this.pendingPrompts.delete(params.sessionId);
        this.sessionStore.clearActiveRun(params.sessionId);
        if (this.pendingPrompts.size === 0) {
          this.clearDisconnectTimer();
        }
        reject(err instanceof Error ? err : new Error(String(err)));
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

  private async resolveSessionKeyFromMeta(params: {
    meta: ReturnType<typeof parseSessionMeta>;
    fallbackKey: string;
  }): Promise<string> {
    const sessionKey = await resolveSessionKey({
      meta: params.meta,
      fallbackKey: params.fallbackKey,
      gateway: this.gateway,
      opts: this.opts,
    });
    await resetSessionIfNeeded({
      meta: params.meta,
      sessionKey,
      gateway: this.gateway,
      opts: this.opts,
    });
    return sessionKey;
  }

  private async handleAgentEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    const stream = payload.stream as string | undefined;
    const runId = payload.runId as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const sessionKey = payload.sessionKey as string | undefined;
    if (!stream || !data || !sessionKey) {
      return;
    }

    if (stream === "approval") {
      await this.handleApprovalEvent({ sessionKey, runId, data });
      return;
    }

    if (stream !== "tool") {
      return;
    }
    const phase = data.phase as string | undefined;
    const name = data.name as string | undefined;
    const toolCallId = data.toolCallId as string | undefined;
    if (!toolCallId) {
      return;
    }

    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    if (phase === "start") {
      if (!pending.toolCalls) {
        pending.toolCalls = new Map();
      }
      if (pending.toolCalls.has(toolCallId)) {
        return;
      }
      const args = data.args as Record<string, unknown> | undefined;
      const title = formatToolTitle(name, args);
      const kind = inferToolKind(name);
      const locations = extractToolCallLocations(args);
      pending.toolCalls.set(toolCallId, {
        title,
        kind,
        rawInput: args,
        locations,
      });
      await this.emitSessionUpdate({
        sessionId: pending.sessionId,
        sessionKey: pending.sessionKey,
        ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
        runId: pending.idempotencyKey,
        record: true,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          status: "in_progress",
          rawInput: args,
          kind,
          locations,
        },
      });
      return;
    }

    if (phase === "update") {
      const toolState = pending.toolCalls?.get(toolCallId);
      const partialResult = data.partialResult;
      await this.emitSessionUpdate({
        sessionId: pending.sessionId,
        sessionKey: pending.sessionKey,
        ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
        runId: pending.idempotencyKey,
        record: true,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          rawOutput: partialResult,
          content: extractToolCallContent(partialResult),
          locations: extractToolCallLocations(toolState?.locations, partialResult),
        },
      });
      return;
    }

    if (phase === "result") {
      const isError = Boolean(data.isError);
      const toolState = pending.toolCalls?.get(toolCallId);
      pending.toolCalls?.delete(toolCallId);
      await this.emitSessionUpdate({
        sessionId: pending.sessionId,
        sessionKey: pending.sessionKey,
        ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
        runId: pending.idempotencyKey,
        record: true,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          rawOutput: data.result,
          content: extractToolCallContent(data.result),
          locations: extractToolCallLocations(toolState?.locations, data.result),
        },
      });
    }
  }

  private async handleApprovalEvent(params: {
    sessionKey: string;
    runId?: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    const approvalEvent = parseGatewayExecApprovalEventData(params.data);
    if (!approvalEvent) {
      return;
    }
    this.startApprovalRelay({
      sessionKey: params.sessionKey,
      runId: params.runId,
      approvalEvent,
    });
  }

  private handleExecApprovalRequestEvent(evt: EventFrame): void {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    const approvalEvent = parseGatewayExecApprovalRequestEventPayload(payload);
    if (!approvalEvent) {
      return;
    }
    const request = payload.request as Record<string, unknown> | undefined;
    const sessionKey = normalizeOptionalString(request?.sessionKey);
    if (!sessionKey) {
      return;
    }
    this.startApprovalRelay({ sessionKey, approvalEvent });
  }

  private startApprovalRelay(params: {
    sessionKey: string;
    runId?: string;
    approvalEvent: GatewayExecApprovalEvent;
  }): void {
    const approvalEvent = params.approvalEvent;
    if (this.approvalRelays.has(approvalEvent.approvalId)) {
      return;
    }

    const pending = params.runId
      ? this.findPendingBySessionKey(params.sessionKey, params.runId)
      : this.findUniquePendingBySessionKey(params.sessionKey);
    if (!pending) {
      return;
    }

    const relay: PendingApprovalRelay = {
      approvalId: approvalEvent.approvalId,
      runId: pending.idempotencyKey,
      sessionId: pending.sessionId,
      sessionKey: pending.sessionKey,
      state: "active",
    };
    this.approvalRelays.set(relay.approvalId, relay);
    void this.runApprovalRelay(relay, approvalEvent);
  }

  private async runApprovalRelay(
    relay: PendingApprovalRelay,
    approvalEvent: GatewayExecApprovalEvent,
  ): Promise<void> {
    let resolved = false;
    try {
      const details = await this.getGatewayApprovalDetails(relay.approvalId);
      if (!this.isApprovalRelayActive(relay)) {
        resolved = await this.resolveGatewayApproval(relay.approvalId, "deny");
        return;
      }

      const request = buildAcpPermissionRequest({
        sessionId: relay.sessionId,
        event: approvalEvent,
        details,
      });
      let decision: GatewayExecApprovalDecision | undefined;
      try {
        const response = await this.connection.requestPermission(request);
        decision = resolveGatewayDecisionFromPermissionOutcome(response, request.options);
      } catch (err) {
        this.log(`approval relay request failed for ${relay.approvalId}: ${String(err)}`);
      }

      const selectedDecision = this.isApprovalRelayActive(relay) && decision ? decision : "deny";
      resolved = await this.resolveGatewayApproval(relay.approvalId, selectedDecision);
    } finally {
      const current = this.approvalRelays.get(relay.approvalId);
      if (current === relay && current.state === "active") {
        if (resolved) {
          // Keep completed relays until prompt cleanup as replay/dedup sentinels.
          current.state = "completed";
        } else {
          this.approvalRelays.delete(relay.approvalId);
        }
      }
    }
  }

  private async getGatewayApprovalDetails(
    approvalId: string,
  ): Promise<GatewayExecApprovalDetails | null> {
    try {
      return await this.gateway.request<GatewayExecApprovalDetails>("exec.approval.get", {
        id: approvalId,
      });
    } catch (err) {
      this.log(`approval relay hydrate failed for ${approvalId}: ${String(err)}`);
      return null;
    }
  }

  private async resolveGatewayApproval(
    approvalId: string,
    decision: GatewayExecApprovalDecision,
  ): Promise<boolean> {
    try {
      await this.gateway.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      return true;
    } catch (err) {
      this.log(`approval relay resolve failed for ${approvalId}: ${String(err)}`);
      return false;
    }
  }

  private isApprovalRelayActive(relay: PendingApprovalRelay): boolean {
    return (
      this.approvalRelays.get(relay.approvalId) === relay &&
      relay.state === "active" &&
      this.getPendingPrompt(relay.sessionId, relay.runId) !== undefined
    );
  }

  private clearApprovalRelaysForPrompt(
    sessionId: string,
    runId?: string,
    opts: { denyActive?: boolean } = {},
  ): void {
    for (const [approvalId, relay] of this.approvalRelays) {
      if (relay.sessionId !== sessionId) {
        continue;
      }
      if (runId && relay.runId !== runId) {
        continue;
      }
      this.approvalRelays.delete(approvalId);
      if (opts.denyActive && relay.state === "active") {
        void this.resolveGatewayApproval(approvalId, "deny");
      }
    }
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
      await this.emitSessionUpdate({
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
    await this.emitSessionUpdate({
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
    pending: PendingPrompt,
    stopReason: StopReason,
  ): Promise<void> {
    this.clearApprovalRelaysForPrompt(sessionId, pending.idempotencyKey, { denyActive: true });
    this.pendingPrompts.delete(sessionId);
    this.sessionStore.clearActiveRun(sessionId);
    if (this.pendingPrompts.size === 0) {
      this.clearDisconnectTimer();
    }
    const sessionSnapshot = await this.getSessionSnapshot(pending.sessionKey);
    try {
      await this.sendSessionSnapshotUpdate(
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
  }

  private findPendingBySessionKey(sessionKey: string, runId?: string): PendingPrompt | undefined {
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

  private findUniquePendingBySessionKey(sessionKey: string): PendingPrompt | undefined {
    let match: PendingPrompt | undefined;
    for (const pending of this.pendingPrompts.values()) {
      if (pending.sessionKey !== sessionKey) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = pending;
    }
    return match;
  }

  private reconcilePendingSessionKey(pending: PendingPrompt, sessionKey: string): void {
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

  private clearDisconnectTimer(): void {
    if (!this.disconnectTimer) {
      return;
    }
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private armDisconnectTimer(disconnectContext: DisconnectContext): void {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      void this.reconcilePendingPrompts(disconnectContext.generation, true);
    }, ACP_GATEWAY_DISCONNECT_GRACE_MS);
    this.disconnectTimer.unref?.();
  }

  private rejectPendingPrompt(pending: PendingPrompt, error: Error): void {
    const currentPending = this.getPendingPrompt(pending.sessionId, pending.idempotencyKey);
    if (currentPending !== pending) {
      return;
    }
    this.clearApprovalRelaysForPrompt(pending.sessionId, pending.idempotencyKey, {
      denyActive: true,
    });
    this.pendingPrompts.delete(pending.sessionId);
    this.sessionStore.clearActiveRun(pending.sessionId);
    if (this.pendingPrompts.size === 0) {
      this.clearDisconnectTimer();
    }
    pending.reject(error);
  }

  private clearPendingDisconnectState(
    pending: PendingPrompt,
    disconnectContext: DisconnectContext,
  ): void {
    if (pending.disconnectContext !== disconnectContext) {
      return;
    }
    pending.disconnectContext = undefined;
  }

  private shouldRejectPendingAtDisconnectDeadline(
    pending: PendingPrompt,
    disconnectContext: DisconnectContext,
  ): boolean {
    return (
      pending.disconnectContext === disconnectContext &&
      (!pending.sendAccepted ||
        this.activeDisconnectContext?.generation === disconnectContext.generation)
    );
  }

  private async reconcilePendingPrompts(
    observedDisconnectGeneration: number,
    deadlineExpired: boolean,
  ): Promise<void> {
    if (this.pendingPrompts.size === 0) {
      if (this.disconnectGeneration === observedDisconnectGeneration) {
        this.clearDisconnectTimer();
      }
      return;
    }

    const pendingEntries = [...this.pendingPrompts.entries()];
    let keepDisconnectTimer = false;
    for (const [sessionId, pending] of pendingEntries) {
      if (this.pendingPrompts.get(sessionId) !== pending) {
        continue;
      }
      if (pending.disconnectContext?.generation !== observedDisconnectGeneration) {
        continue;
      }
      const shouldKeepPending = await this.reconcilePendingPrompt(
        sessionId,
        pending,
        deadlineExpired,
      );
      if (shouldKeepPending) {
        keepDisconnectTimer = true;
      }
    }

    if (!keepDisconnectTimer && this.disconnectGeneration === observedDisconnectGeneration) {
      this.clearDisconnectTimer();
    }
  }

  private async reconcilePendingPrompt(
    sessionId: string,
    pending: PendingPrompt,
    deadlineExpired: boolean,
  ): Promise<boolean> {
    const disconnectContext = pending.disconnectContext;
    if (!disconnectContext) {
      return false;
    }
    let result: AgentWaitResult | undefined;
    try {
      result = await this.gateway.request(
        "agent.wait",
        {
          runId: pending.idempotencyKey,
          timeoutMs: 0,
        },
        { timeoutMs: null },
      );
    } catch (err) {
      this.log(`agent.wait reconcile failed for ${pending.idempotencyKey}: ${String(err)}`);
      if (deadlineExpired) {
        if (this.shouldRejectPendingAtDisconnectDeadline(pending, disconnectContext)) {
          this.rejectPendingPrompt(
            pending,
            new Error(`Gateway disconnected: ${disconnectContext.reason}`),
          );
          return false;
        }
        this.clearPendingDisconnectState(pending, disconnectContext);
        return false;
      }
      return true;
    }

    const currentPending = this.getPendingPrompt(sessionId, pending.idempotencyKey);
    if (!currentPending) {
      return false;
    }
    if (result?.status === "ok") {
      await this.finishPrompt(sessionId, currentPending, "end_turn");
      return false;
    }
    if (result?.status === "error") {
      void this.finishPrompt(sessionId, currentPending, "end_turn");
      return false;
    }
    if (deadlineExpired) {
      if (this.shouldRejectPendingAtDisconnectDeadline(currentPending, disconnectContext)) {
        const currentDisconnectContext = currentPending.disconnectContext;
        if (!currentDisconnectContext) {
          return false;
        }
        this.rejectPendingPrompt(
          currentPending,
          new Error(`Gateway disconnected: ${currentDisconnectContext.reason}`),
        );
        return false;
      }
      this.clearPendingDisconnectState(currentPending, disconnectContext);
      return false;
    }
    return true;
  }

  private async startLedgerSession(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string; cwd: string },
    options: { complete: boolean; reset?: boolean },
  ): Promise<void> {
    try {
      await this.eventLedger.startSession({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
        cwd: session.cwd,
        complete: options.complete,
        ...(options.reset ? { reset: true } : {}),
      });
    } catch (err) {
      this.log(`event ledger session start failed for ${session.sessionId}: ${String(err)}`);
    }
  }

  private async readLedgerReplay(params: {
    sessionId: string;
    sessionKey: string;
  }): Promise<AcpEventLedgerReplay> {
    try {
      return await this.eventLedger.readReplay(params);
    } catch (err) {
      this.log(`event ledger replay fallback for ${params.sessionId}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  private async readLedgerReplayBySessionId(sessionId: string): Promise<AcpEventLedgerReplay> {
    try {
      return await this.eventLedger.readReplayBySessionId({ sessionId });
    } catch (err) {
      this.log(`event ledger exact replay fallback for ${sessionId}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  private async readLedgerReplayBySessionKey(sessionKey: string): Promise<AcpEventLedgerReplay> {
    try {
      return await this.eventLedger.readReplayBySessionKey({ sessionKey });
    } catch (err) {
      this.log(`event ledger session-key replay fallback for ${sessionKey}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  private async recordUserPrompt(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    runId: string,
    prompt: PromptRequest["prompt"],
  ): Promise<void> {
    try {
      await this.eventLedger.recordUserPrompt({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
        runId,
        prompt,
      });
    } catch (err) {
      this.log(`event ledger prompt record failed for ${session.sessionId}: ${String(err)}`);
      await this.markLedgerIncomplete(session);
    }
  }

  private async recordLedgerUpdate(params: {
    sessionId: string;
    sessionKey: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
  }): Promise<void> {
    try {
      await this.eventLedger.recordUpdate({
        sessionId: params.ledgerSessionId ?? params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.runId ? { runId: params.runId } : {}),
        update: params.update,
      });
    } catch (err) {
      this.log(`event ledger update record failed for ${params.sessionId}: ${String(err)}`);
      await this.markLedgerIncomplete({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
      });
    }
  }

  private async markLedgerIncomplete(session: {
    sessionId: string;
    sessionKey: string;
    ledgerSessionId?: string;
  }): Promise<void> {
    try {
      await this.eventLedger.markIncomplete({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
      });
    } catch (err) {
      this.log(`event ledger incomplete mark failed for ${session.sessionId}: ${String(err)}`);
    }
  }

  private async emitSessionUpdate(params: {
    sessionId: string;
    sessionKey?: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
    record?: boolean;
  }): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: params.update,
    });
    if (params.record && params.sessionKey) {
      await this.recordLedgerUpdate({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        update: params.update,
      });
    }
  }

  private async sendAvailableCommands(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    options: { record: boolean },
  ): Promise<void> {
    await this.emitSessionUpdate({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      record: options.record,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: await getAvailableCommandsForAcp(),
      },
    });
  }

  private async getSessionSnapshot(
    sessionKey: string,
    overrides?: Partial<GatewaySessionPresentationRow>,
  ): Promise<SessionSnapshot> {
    try {
      const row = await this.getGatewaySessionRow(sessionKey);
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    } catch (err) {
      this.log(`session presentation fallback for ${sessionKey}: ${String(err)}`);
      return {
        ...buildSessionPresentation({ overrides }),
        metadata: buildSessionMetadata({ sessionKey }),
      };
    }
  }

  private async getExistingSessionSnapshot(sessionKey: string): Promise<SessionSnapshot> {
    const row = await this.getGatewaySessionRow(sessionKey);
    if (!row) {
      throw new Error(`Session ${sessionKey} not found`);
    }
    return {
      ...buildSessionPresentation({ row }),
      metadata: buildSessionMetadata({ row, sessionKey }),
      usage: buildSessionUsageSnapshot(row),
    };
  }

  private mapGatewaySessionToAcpSessionInfo(
    session: GatewaySessionRow,
    fallbackCwd: string,
  ): SessionInfo {
    const cwd = normalizeOptionalString(session.spawnedWorkspaceDir) ?? fallbackCwd;
    return {
      sessionId: session.key,
      cwd,
      title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
      updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : undefined,
      _meta: toAcpSessionLineageMeta(session),
    };
  }

  private async cancelSessionWork(session: {
    sessionId: string;
    sessionKey: string;
    activeRunId: string | null;
  }): Promise<void> {
    // Capture runId before cancelActiveRun clears session.activeRunId.
    const activeRunId = session.activeRunId;

    this.sessionStore.cancelActiveRun(session.sessionId);
    const pending = this.pendingPrompts.get(session.sessionId);
    const scopedRunId = activeRunId ?? pending?.idempotencyKey;

    if (scopedRunId) {
      try {
        await this.gateway.request("chat.abort", {
          sessionKey: session.sessionKey,
          runId: scopedRunId,
        });
      } catch (err) {
        this.log(`cancel error: ${String(err)}`);
      }
    }

    if (pending) {
      this.clearApprovalRelaysForPrompt(session.sessionId, pending.idempotencyKey, {
        denyActive: true,
      });
      this.pendingPrompts.delete(session.sessionId);
      if (this.pendingPrompts.size === 0) {
        this.clearDisconnectTimer();
      }
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  private async getGatewaySessionRow(
    sessionKey: string,
  ): Promise<GatewaySessionPresentationRow | undefined> {
    const result = await this.gateway.request<SessionsListResult>("sessions.list", {
      limit: 200,
      search: sessionKey,
      includeDerivedTitles: true,
    });
    const session = result.sessions.find((entry) => entry.key === sessionKey);
    if (!session) {
      return undefined;
    }
    return {
      key: session.key,
      kind: session.kind,
      channel: session.channel,
      parentSessionKey: session.parentSessionKey,
      spawnedBy: session.spawnedBy,
      spawnDepth: session.spawnDepth,
      subagentRole: session.subagentRole,
      subagentControlScope: session.subagentControlScope,
      spawnedWorkspaceDir: session.spawnedWorkspaceDir,
      displayName: session.displayName,
      label: session.label,
      derivedTitle: session.derivedTitle,
      updatedAt: session.updatedAt,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.thinkingLevels,
      modelProvider: session.modelProvider,
      model: session.model,
      fastMode: session.fastMode,
      verboseLevel: session.verboseLevel,
      traceLevel: session.traceLevel,
      reasoningLevel: session.reasoningLevel,
      responseUsage: session.responseUsage,
      elevatedLevel: session.elevatedLevel,
      totalTokens: session.totalTokens,
      totalTokensFresh: session.totalTokensFresh,
      contextTokens: session.contextTokens,
    };
  }

  private resolveSessionConfigPatch(
    configId: string,
    value: string | boolean,
  ): {
    overrides: Partial<GatewaySessionPresentationRow>;
    patch?: Record<string, string | boolean>;
  } {
    if (typeof value !== "string") {
      throw new Error(
        `ACP bridge does not support non-string session config option values for "${configId}".`,
      );
    }
    switch (configId) {
      case ACP_THOUGHT_LEVEL_CONFIG_ID:
        return {
          patch: { thinkingLevel: value },
          overrides: { thinkingLevel: value },
        };
      case ACP_FAST_MODE_CONFIG_ID:
        return {
          patch: { fastMode: value === "on" },
          overrides: { fastMode: value === "on" },
        };
      case ACP_VERBOSE_LEVEL_CONFIG_ID:
        return {
          patch: { verboseLevel: value },
          overrides: { verboseLevel: value },
        };
      case ACP_TRACE_LEVEL_CONFIG_ID:
        return {
          patch: { traceLevel: value },
          overrides: { traceLevel: value },
        };
      case ACP_REASONING_LEVEL_CONFIG_ID:
        return {
          patch: { reasoningLevel: value },
          overrides: { reasoningLevel: value },
        };
      case ACP_RESPONSE_USAGE_CONFIG_ID:
        return {
          patch: { responseUsage: value },
          overrides: { responseUsage: value as GatewaySessionPresentationRow["responseUsage"] },
        };
      case ACP_ELEVATED_LEVEL_CONFIG_ID:
        return {
          patch: { elevatedLevel: value },
          overrides: { elevatedLevel: value },
        };
      case ACP_TIMEOUT_CONFIG_ID:
      case ACP_TIMEOUT_SECONDS_CONFIG_ID:
        return {
          overrides: {},
        };
      default:
        throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
    }
  }

  private async getSessionTranscript(sessionKey: string): Promise<GatewayTranscriptMessage[]> {
    const result = await this.gateway.request("sessions.get", {
      key: sessionKey,
      limit: ACP_LOAD_SESSION_REPLAY_LIMIT,
    });
    if (!Array.isArray(result.messages)) {
      return [];
    }
    return result.messages as GatewayTranscriptMessage[];
  }

  private async replaySessionTranscript(
    sessionId: string,
    transcript: ReadonlyArray<GatewayTranscriptMessage>,
  ): Promise<void> {
    for (const message of transcript) {
      const replayChunks = extractReplayChunks(message);
      for (const chunk of replayChunks) {
        await this.emitSessionUpdate({
          sessionId,
          update: {
            sessionUpdate: chunk.sessionUpdate,
            content: { type: "text", text: chunk.text },
          },
        });
      }
    }
  }

  private async replayLedgerSession(
    sessionId: string,
    ledgerReplay: AcpEventLedgerReplay,
  ): Promise<void> {
    for (const event of ledgerReplay.events) {
      await this.emitSessionUpdate({
        sessionId,
        update: event.update,
        record: false,
      });
    }
  }

  private async sendSessionSnapshotUpdate(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    sessionSnapshot: SessionSnapshot,
    options: { includeControls: boolean; record: boolean; runId?: string },
  ): Promise<void> {
    if (options.includeControls) {
      await this.emitSessionUpdate({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: sessionSnapshot.modes.currentModeId,
        },
      });
      await this.emitSessionUpdate({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: sessionSnapshot.configOptions,
        },
      });
    }
    if (sessionSnapshot.metadata) {
      await this.emitSessionUpdate({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "session_info_update",
          ...sessionSnapshot.metadata,
        },
      });
    }
    if (sessionSnapshot.usage) {
      await this.emitSessionUpdate({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "usage_update",
          used: sessionSnapshot.usage.used,
          size: sessionSnapshot.usage.size,
          _meta: {
            source: "gateway-session-store",
            approximate: true,
          },
        },
      });
    }
  }

  private assertSupportedSessionSetup(mcpServers: ReadonlyArray<unknown>): void {
    if (mcpServers.length === 0) {
      return;
    }
    throw new Error(
      "ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead.",
    );
  }

  private enforceSessionCreateRateLimit(
    method: "newSession" | "loadSession" | "resumeSession",
  ): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
    );
  }
}
