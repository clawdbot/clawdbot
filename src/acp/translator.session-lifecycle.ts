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
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params["_meta"]);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: `acp-bridge:${sessionId}`,
    });

    const session = this.sessionStore.createSession({
      sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: true, reset: true });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    const sessionSnapshot = await this.sessionState.getSnapshot(session.sessionKey);
    // Pre-fetch available commands BEFORE arming the snapshot delivery timer.
    // The lazy command-module import yields to the event loop; if that yield
    // happens after the snapshot's setTimeout(0) is armed, the snapshot
    // notification can overtake the session/new RPC response. Resolving
    // commands first ensures no async yield occurs between arming the timer
    // and returning the result.
    const availableCommands = await this.sessionUpdates.prepareAvailableCommands();
    // Defer notification delivery past the RPC response boundary so the client
    // receives session/new result before session_info_update. The guard fences
    // the deferred callback by the captured session instance: after close the
    // store removes this object, and a resume with the same ID creates a new
    // one, so the stale callback is suppressed instead of leaking.
    const deliveryGuard = () => this.sessionStore.getSession(session.sessionId) === session;
    await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: true,
      deferDelivery: true,
      deliveryGuard,
    });
    await this.sessionUpdates.sendAvailableCommands(session, {
      record: true,
      deferDelivery: true,
      deliveryGuard,
      availableCommands,
    });
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
    const ledgerReplay =
      exactLedgerReplay.complete && exactLedgerReplay.sessionKey === sessionKey
        ? exactLedgerReplay
        : listedLedgerReplay.complete && listedLedgerReplay.sessionKey === sessionKey
          ? listedLedgerReplay
          : await this.sessionUpdates.readLedgerReplay({
              sessionId: params.sessionId,
              sessionKey,
            });

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      ...(ledgerReplay.sessionId ? { ledgerSessionId: ledgerReplay.sessionId } : {}),
      cwd: params.cwd,
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

    const shouldRequireGatewaySession =
      !existingSession || sessionKey !== existingSession.sessionKey;
    const sessionSnapshot = shouldRequireGatewaySession
      ? await this.sessionState.getExistingSnapshot(sessionKey)
      : await this.sessionState.getSnapshot(sessionKey);

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: false });
    this.log(`resumeSession: ${session.sessionId} -> ${session.sessionKey}`);
    // Pre-fetch commands before arming the snapshot timer (same invariant
    // as newSession: the lazy import yield must not let the snapshot timer
    // fire before the handler returns).
    const availableCommands = await this.sessionUpdates.prepareAvailableCommands();
    // Same deferred-delivery contract as newSession: the resume result must
    // reach the client before session_info_update. Guard by the captured
    // session instance to suppress stale callbacks after close-then-resume.
    const deliveryGuard = () => this.sessionStore.getSession(session.sessionId) === session;
    await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
      includeControls: false,
      record: false,
      deferDelivery: true,
      deliveryGuard,
    });
    await this.sessionUpdates.sendAvailableCommands(session, {
      record: false,
      deferDelivery: true,
      deliveryGuard,
      availableCommands,
    });
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

  private async resolveSessionKeyFromMeta(params: {
    meta: ReturnType<typeof parseSessionMeta>;
    fallbackKey: string;
  }): Promise<string> {
    const sessionKey = await resolveAcpSessionKey({
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
