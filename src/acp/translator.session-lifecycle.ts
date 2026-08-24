/** ACP session creation, loading, listing, resuming, closing, and configuration. */
import { randomUUID } from "node:crypto";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionInfo,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import type { SessionsListResult } from "../gateway/session-utils.js";
import type { FixedWindowRateLimiter } from "../infra/fixed-window-rate-limit.js";
import type { AcpEventLedgerReplay } from "./event-ledger.js";
import { parseSessionMeta, resetSessionIfNeeded, resolveAcpSessionKey } from "./session-mapper.js";
import { extractReplayChunks, type GatewayTranscriptMessage } from "./translator.replay.js";
import {
  ACP_LIST_SESSIONS_MAX_FETCH_LIMIT,
  assertAbsoluteCwd,
  decodeListSessionsCursor,
  encodeListSessionsCursor,
  resolveListSessionsPageSize,
} from "./translator.session-list.js";
import type { AcpTranslatorSessionState } from "./translator.session-state.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;

function hasExplicitSessionRouting(
  meta: ReturnType<typeof parseSessionMeta>,
  opts: AcpServerOptions,
): boolean {
  return Boolean(
    meta.sessionKey || meta.sessionLabel || opts.defaultSessionKey || opts.defaultSessionLabel,
  );
}

export class AcpTranslatorSessionLifecycle {
  constructor(
    private readonly gateway: GatewayClient,
    private readonly opts: AcpServerOptions,
    private readonly sessionStore: AcpSessionStore,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly sessionState: AcpTranslatorSessionState,
    private readonly sessionCreateRateLimiter: FixedWindowRateLimiter,
    private readonly cancelSessionWork: (session: {
      sessionId: string;
      sessionKey: string;
      activeRunId: string | null;
    }) => Promise<void>,
    private readonly log: (msg: string) => void,
  ) {}

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    assertAbsoluteCwd(params.cwd, "session/new");
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params["_meta"]);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: `acp-bridge:${sessionId}`,
    });
    // chat.send carries no cwd, so the requested directory only reaches a turn as the row's
    // spawnedCwd. cwdOnCreateOnly lets the Gateway settle absence inside its own mutation. A
    // Gateway without it would apply the directory to a row it merely adopts, so a routed key
    // cannot be honored there; a bridge-minted id is safe because nothing else can own it.
    const scopesCwdToNewSessions = this.gateway.hasServerCapability(
      GATEWAY_SERVER_CAPS.SESSIONS_CREATE_CWD_ON_CREATE_ONLY,
    );
    if (!scopesCwdToNewSessions && hasExplicitSessionRouting(meta, this.opts)) {
      // Refuse before any reset so a rejected request leaves the routed session untouched.
      throw new Error(
        `ACP session/new cannot apply ${params.cwd} to session ${sessionKey}: this Gateway cannot scope a working directory to newly created sessions, so honoring it could overwrite that session's own directory. Update the Gateway, or omit the session key to start a new session.`,
      );
    }

    const created = await this.gateway.request<{ entry?: { spawnedCwd?: string } }>(
      "sessions.create",
      {
        key: sessionKey,
        cwd: params.cwd,
        ...(scopesCwdToNewSessions ? { cwdOnCreateOnly: true } : {}),
      },
    );
    // The Gateway owns the run directory, so read back what it kept rather than assuming the
    // request won. A create that passed a cwd always returns one for a new row, so its absence
    // means an existing row owns this key and has no directory: the turn would run in the agent
    // workspace while ACP reported otherwise, so refuse instead of claiming a directory.
    const sessionCwd = normalizeOptionalString(created?.entry?.spawnedCwd);
    if (!sessionCwd) {
      throw new Error(
        `ACP session/new cannot use ${params.cwd}: session ${sessionKey} already exists without a working directory, so the agent would run in its workspace instead. Route to a session created with that directory, or omit the session key to start a new one.`,
      );
    }

    // Reset last: it runs after the row carries its directory, so a requested reset preserves the
    // cwd instead of materializing a bare row that the check above would then reject.
    await this.resetRoutedSession(meta, sessionKey);

    const session = this.sessionStore.createSession({ sessionId, sessionKey, cwd: sessionCwd });
    await this.sessionUpdates.startLedgerSession(session, { complete: true, reset: true });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    const sessionSnapshot = await this.sessionState.getSnapshot(session.sessionKey);
    await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: true,
    });
    await this.sessionUpdates.sendAvailableCommands(session, { record: true });
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

    const meta = parseSessionMeta(params["_meta"]);
    const hasExplicitRouting = hasExplicitSessionRouting(meta, this.opts);
    const exactLedgerReplay: AcpEventLedgerReplay = hasExplicitRouting
      ? { complete: false, events: [] }
      : await this.sessionUpdates.readLedgerReplayBySessionId(params.sessionId);
    const listedLedgerReplay: AcpEventLedgerReplay =
      !hasExplicitRouting && !exactLedgerReplay.complete
        ? await this.sessionUpdates.readLedgerReplayBySessionKey(params.sessionId)
        : { complete: false, events: [] };
    const routedLedgerReplay = exactLedgerReplay.complete ? exactLedgerReplay : listedLedgerReplay;
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: routedLedgerReplay.sessionKey ?? params.sessionId,
    });
    await this.resetRoutedSession(meta, sessionKey);
    const ledgerReplay =
      exactLedgerReplay.complete && exactLedgerReplay.sessionKey === sessionKey
        ? exactLedgerReplay
        : listedLedgerReplay.complete && listedLedgerReplay.sessionKey === sessionKey
          ? listedLedgerReplay
          : await this.sessionUpdates.readLedgerReplay({
              sessionId: params.sessionId,
              sessionKey,
            });

    // Adopting an existing Gateway session inherits its directory; reporting the requested one
    // would make the prompt prefix and provenance receipt describe a cwd the turn never uses.
    const adoptedCwd = await this.sessionState.getSessionCwd(sessionKey);
    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      ...(ledgerReplay.sessionId ? { ledgerSessionId: ledgerReplay.sessionId } : {}),
      cwd: adoptedCwd ?? params.cwd,
      runtimeCwd: adoptedCwd !== undefined,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: ledgerReplay.complete });
    this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
    const [sessionSnapshot, transcript] = await Promise.all([
      this.sessionState.getSnapshot(session.sessionKey),
      ledgerReplay.complete
        ? Promise.resolve([])
        : this.getSessionTranscript(session.sessionKey).catch((err: unknown) => {
            this.log(`session transcript fallback for ${session.sessionKey}: ${String(err)}`);
            return [];
          }),
    ]);
    if (ledgerReplay.complete) {
      await this.replayLedgerSession(session.sessionId, ledgerReplay);
    } else {
      await this.replaySessionTranscript(session.sessionId, transcript);
    }
    await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: false,
    });
    await this.sessionUpdates.sendAvailableCommands(session, { record: false });
    const { configOptions, modes } = sessionSnapshot;
    return { configOptions, modes };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const requestedCwd = normalizeOptionalString(params.cwd);
    if (requestedCwd) {
      assertAbsoluteCwd(requestedCwd, "session/list");
    }
    const fallbackCwd = requestedCwd ?? process.cwd();
    const rawCursor = params.cursor;
    const cursor = decodeListSessionsCursor(rawCursor);
    if (rawCursor && cursor.cwd !== requestedCwd) {
      throw new Error("ACP session list cursor does not match the cwd filter.");
    }

    const pageSize = resolveListSessionsPageSize(params["_meta"]);
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
          return (
            (normalizeOptionalString(session.spawnedCwd) ??
              normalizeOptionalString(session.spawnedWorkspaceDir)) === requestedCwd
          );
        })
        .map((session) => this.sessionState.mapGatewaySession(session, fallbackCwd));
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

    const meta = parseSessionMeta(params["_meta"]);
    const fallbackKey = existingSession?.sessionKey ?? params.sessionId;
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey,
    });
    await this.resetRoutedSession(meta, sessionKey);

    const shouldRequireGatewaySession =
      !existingSession || sessionKey !== existingSession.sessionKey;
    const sessionSnapshot = shouldRequireGatewaySession
      ? await this.sessionState.getExistingSnapshot(sessionKey)
      : await this.sessionState.getSnapshot(sessionKey);

    // Resume rebinds to a Gateway session that owns its directory; report that, not the request.
    const resumedCwd = await this.sessionState.getSessionCwd(sessionKey);
    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      cwd: resumedCwd ?? params.cwd,
      runtimeCwd: resumedCwd !== undefined,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: false });
    this.log(`resumeSession: ${session.sessionId} -> ${session.sessionKey}`);
    await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: false,
    });
    await this.sessionUpdates.sendAvailableCommands(session, { record: false });
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
      const sessionSnapshot = await this.sessionState.getSnapshot(session.sessionKey, {
        thinkingLevel: params.modeId,
      });
      await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
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
    const sessionPatch = this.sessionState.resolveConfigPatch(params.configId, params.value);

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
      const sessionSnapshot = await this.sessionState.getSnapshot(
        session.sessionKey,
        sessionPatch.overrides,
      );
      await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
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

  /** Resolves the routed key only; callers decide when a requested reset may run. */
  private async resolveSessionKeyFromMeta(params: {
    meta: ReturnType<typeof parseSessionMeta>;
    fallbackKey: string;
  }): Promise<string> {
    return await resolveAcpSessionKey({
      meta: params.meta,
      fallbackKey: params.fallbackKey,
      gateway: this.gateway,
      opts: this.opts,
    });
  }

  private async resetRoutedSession(
    meta: ReturnType<typeof parseSessionMeta>,
    sessionKey: string,
  ): Promise<void> {
    await resetSessionIfNeeded({ meta, sessionKey, gateway: this.gateway, opts: this.opts });
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
        await this.sessionUpdates.emit({
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
      await this.sessionUpdates.emit({
        sessionId,
        update: event.update,
        record: false,
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
