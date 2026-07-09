/**
 * Codex app-server supervisor that lists sessions, reads transcripts, and
 * starts/steers/interrupts turns across configured endpoints.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { connectCodexAppServerEndpoint } from "./json-rpc-client.js";
import type {
  CodexJsonRpcConnection,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
  CodexSessionCatalogSession,
  CodexSupervisorEndpoint,
  CodexSupervisorEndpointHealth,
  CodexSupervisorSendResult,
  CodexSupervisorSession,
  CodexSupervisorSessionListResult,
  CodexSupervisorThreadStatus,
  CodexSupervisorTurnMode,
} from "./types.js";

type EndpointConnector = (endpoint: CodexSupervisorEndpoint) => Promise<CodexJsonRpcConnection>;

const ALL_CODEX_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];
const DEFAULT_MAX_STORED_SESSIONS = 200;
const DEFAULT_CATALOG_PAGE_LIMIT = 50;
const MAX_CATALOG_PAGE_LIMIT = 100;
const MAX_CATALOG_SESSION_ID_LENGTH = 256;
const MAX_CATALOG_SESSION_NAME_LENGTH = 500;
const MAX_CATALOG_CWD_LENGTH = 4096;
const MAX_CATALOG_STATUS_LENGTH = 64;
const MAX_CATALOG_METADATA_LENGTH = 500;
const MAX_CATALOG_ACTIVE_FLAGS = 16;
const MAX_CATALOG_ACTIVE_FLAG_LENGTH = 128;
const MAX_CATALOG_CURSOR_LENGTH = 4096;

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function extractThread(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (isRecord(value.thread)) {
    return value.thread;
  }
  return undefined;
}

function extractThreadList(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  if (Array.isArray(value.data)) {
    return asRecordArray(value.data);
  }
  if (Array.isArray(value.threads)) {
    return asRecordArray(value.threads);
  }
  if (Array.isArray(value.loadedThreads)) {
    return asRecordArray(value.loadedThreads);
  }
  return [];
}

function extractStringList(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data.filter((entry) => typeof entry === "string");
}

function getStatusType(thread: Record<string, unknown>): CodexSupervisorThreadStatus {
  const status = thread.status;
  if (isRecord(status) && typeof status.type === "string") {
    return status.type;
  }
  if (typeof status === "string") {
    return status;
  }
  return "unknown";
}

function boundedCatalogString(
  value: unknown,
  maxLength: number,
  overflow: "omit" | "truncate" = "omit",
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return overflow === "truncate" ? truncateUtf16Safe(normalized, maxLength) : undefined;
}

function getCatalogStatus(thread: Record<string, unknown>): string {
  const status = thread.status;
  const value = isRecord(status) ? status.type : status;
  return boundedCatalogString(value, MAX_CATALOG_STATUS_LENGTH) ?? "notLoaded";
}

function getCatalogActiveFlags(thread: Record<string, unknown>): string[] | undefined {
  const status = thread.status;
  if (!isRecord(status) || !Array.isArray(status.activeFlags)) {
    return undefined;
  }
  const flags = status.activeFlags
    .flatMap((entry) => {
      const flag = boundedCatalogString(entry, MAX_CATALOG_ACTIVE_FLAG_LENGTH);
      return flag ? [flag] : [];
    })
    .slice(0, MAX_CATALOG_ACTIVE_FLAGS);
  return flags.length > 0 ? flags : undefined;
}

function getCatalogSourceLabel(value: unknown): string | undefined {
  let source: string | undefined;
  if (typeof value === "string") {
    source = value;
  } else if (isRecord(value)) {
    const custom = typeof value.custom === "string" ? value.custom.trim() : undefined;
    source = custom ? `custom:${custom}` : Object.keys(value).toSorted()[0];
  }
  return boundedCatalogString(source, MAX_CATALOG_METADATA_LENGTH, "truncate");
}

function boundedCatalogCursor(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CATALOG_CURSOR_LENGTH) {
    return undefined;
  }
  // App Server cursors are opaque, so preserve their bytes after validation.
  return value;
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toCatalogSession(
  thread: Record<string, unknown>,
  archived: boolean,
): CodexSessionCatalogSession | undefined {
  const threadId = boundedCatalogString(thread.id, MAX_CATALOG_SESSION_ID_LENGTH);
  if (!threadId) {
    return undefined;
  }
  const activeFlags = getCatalogActiveFlags(thread);
  const source = getCatalogSourceLabel(thread.source);
  const gitInfo = isRecord(thread.gitInfo) ? thread.gitInfo : undefined;
  const createdAt = getFiniteNumber(thread.createdAt);
  const updatedAt = getFiniteNumber(thread.updatedAt);
  const recencyAt = thread.recencyAt === null ? null : getFiniteNumber(thread.recencyAt);
  const sessionId = boundedCatalogString(thread.sessionId, MAX_CATALOG_SESSION_ID_LENGTH);
  const name = boundedCatalogString(thread.name, MAX_CATALOG_SESSION_NAME_LENGTH, "truncate");
  const cwd = boundedCatalogString(thread.cwd, MAX_CATALOG_CWD_LENGTH);
  const modelProvider = boundedCatalogString(
    thread.modelProvider,
    MAX_CATALOG_METADATA_LENGTH,
    "truncate",
  );
  const cliVersion = boundedCatalogString(
    thread.cliVersion,
    MAX_CATALOG_METADATA_LENGTH,
    "truncate",
  );
  const gitBranch = boundedCatalogString(gitInfo?.branch, MAX_CATALOG_METADATA_LENGTH, "truncate");
  return {
    threadId,
    status: getCatalogStatus(thread),
    archived,
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    ...(activeFlags ? { activeFlags } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(recencyAt !== undefined ? { recencyAt } : {}),
    ...(source ? { source } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
}

function normalizeCatalogLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CATALOG_PAGE_LIMIT;
  }
  return Math.min(MAX_CATALOG_PAGE_LIMIT, Math.max(1, Math.floor(value)));
}

function toSession(
  endpointId: string,
  thread: Record<string, unknown>,
  humanAttached?: boolean,
): CodexSupervisorSession | undefined {
  if (typeof thread.id !== "string") {
    return undefined;
  }
  return {
    endpointId,
    threadId: thread.id,
    status: getStatusType(thread),
    ...(typeof thread.sessionId === "string" ? { sessionId: thread.sessionId } : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(typeof thread.preview === "string" ? { preview: thread.preview } : {}),
    ...("name" in thread && (typeof thread.name === "string" || thread.name === null)
      ? { name: thread.name }
      : {}),
    ...(typeof thread.source === "string" ? { source: thread.source } : {}),
    ...(typeof thread.updatedAt === "number" ? { updatedAt: thread.updatedAt } : {}),
    ...(humanAttached !== undefined ? { humanAttached } : {}),
  };
}

function findInProgressTurnId(thread: Record<string, unknown>): string | undefined {
  const turns = asRecordArray(thread.turns);
  for (const turn of turns.toReversed()) {
    if (turn.status === "inProgress" && typeof turn.id === "string") {
      return turn.id;
    }
  }
  return undefined;
}

function isLoadedThreadReadMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("thread not found") || message.includes("thread not loaded");
}

/** High-level supervisor facade used by OpenClaw tools and MCP tools. */
export class CodexSupervisor {
  private readonly connections = new Map<string, Promise<CodexJsonRpcConnection>>();

  constructor(
    private readonly endpoints: CodexSupervisorEndpoint[],
    private readonly connector: EndpointConnector = connectCodexAppServerEndpoint,
  ) {}

  /** Returns configured endpoint definitions without opening connections. */
  listEndpoints(): CodexSupervisorEndpoint[] {
    return this.endpoints;
  }

  /** Closes all open app-server connections owned by this supervisor. */
  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.connections.values());
    this.connections.clear();
    await Promise.all(
      settled.map(async (entry) => {
        if (entry.status === "fulfilled") {
          await entry.value.close();
        }
      }),
    );
  }

  /** Checks whether each endpoint can service a lightweight thread list call. */
  async probeEndpoints(): Promise<CodexSupervisorEndpointHealth[]> {
    return await Promise.all(
      this.endpoints.map(async (endpoint) => {
        try {
          const connection = await this.connectionFor(endpoint.id);
          await connection.request("thread/loaded/list", { limit: 1 });
          return { endpointId: endpoint.id, ok: true };
        } catch (error) {
          this.forgetEndpoint(endpoint.id);
          return {
            endpointId: endpoint.id,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  /** Lists sessions, returning only the session array for agent-tool callers. */
  async listSessions(
    params: { includeStored?: boolean; maxStoredSessions?: number } = {},
  ): Promise<CodexSupervisorSession[]> {
    return (await this.listSessionSnapshot(params)).sessions;
  }

  /** Lists sessions plus endpoint errors for structured tool output. */
  async listSessionSnapshot(
    params: { includeStored?: boolean; maxStoredSessions?: number } = {},
  ): Promise<CodexSupervisorSessionListResult> {
    const sessions: CodexSupervisorSession[] = [];
    const errors: CodexSupervisorEndpointHealth[] = [];
    for (const endpoint of this.endpoints) {
      try {
        sessions.push(...(await this.listEndpointSessions(endpoint, params)));
      } catch (error) {
        this.forgetEndpoint(endpoint.id);
        errors.push({
          endpointId: endpoint.id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { sessions, errors };
  }

  /** Lists one metadata-only page from one configured Codex app-server endpoint. */
  async listSessionCatalogPage(
    endpointId: string,
    params: CodexSessionCatalogPageParams = {},
  ): Promise<CodexSessionCatalogPage> {
    const connection = await this.connectionFor(endpointId);
    const archived = params.archived === true;
    const limit = normalizeCatalogLimit(params.limit);
    try {
      const listed = await connection.request("thread/list", {
        limit,
        sortKey: "recency_at",
        sortDirection: "desc",
        modelProviders: [],
        archived,
        useStateDbOnly: false,
        ...(params.cursor?.trim() ? { cursor: params.cursor.trim() } : {}),
        ...(params.cwd?.trim() ? { cwd: params.cwd.trim() } : {}),
      });
      if (!isRecord(listed) || !Array.isArray(listed.data)) {
        throw new Error("Codex thread/list returned an invalid response");
      }
      const searchTerm = params.searchTerm?.trim();
      const sessions = asRecordArray(listed.data)
        .slice(0, limit)
        .flatMap((thread) => {
          const session = toCatalogSession(thread, archived);
          return session ? [session] : [];
        })
        // Codex's state query also searches transcript-derived preview text.
        // Filter normalized titles here so catalog search cannot probe previews.
        .filter((session) => !searchTerm || session.name?.includes(searchTerm));
      const nextCursor = boundedCatalogCursor(listed.nextCursor);
      const backwardsCursor = boundedCatalogCursor(listed.backwardsCursor);
      return {
        sessions,
        ...(nextCursor ? { nextCursor } : {}),
        ...(backwardsCursor ? { backwardsCursor } : {}),
      };
    } catch (error) {
      this.forgetEndpoint(endpointId);
      throw error;
    }
  }

  /** Reads a single Codex session transcript from the resolved endpoint. */
  async readSession(params: {
    endpointId?: string;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<Record<string, unknown>> {
    const endpointId = await this.resolveEndpointId(params);
    const connection = await this.connectionFor(endpointId);
    try {
      const result = await this.readThread(
        connection,
        params.threadId,
        params.includeTurns === true,
      );
      if (!isRecord(result)) {
        throw new Error("Codex thread/read returned a non-object response");
      }
      return result;
    } catch (error) {
      this.forgetEndpoint(endpointId);
      throw error;
    }
  }

  /** Starts a new turn or steers an active turn depending on requested mode. */
  async sendToSession(params: {
    endpointId?: string;
    threadId: string;
    text: string;
    mode?: CodexSupervisorTurnMode;
  }): Promise<CodexSupervisorSendResult> {
    const endpointId = await this.resolveEndpointId(params);
    const connection = await this.connectionFor(endpointId);
    try {
      const mode = params.mode ?? "auto";
      if (mode === "start") {
        return await this.startTurn(connection, endpointId, params.threadId, params.text);
      }

      const read = await this.readThread(connection, params.threadId, false);
      const thread = extractThread(read);
      if (!thread) {
        throw new Error(`Codex thread not found: ${params.threadId}`);
      }
      const status = getStatusType(thread);
      if (mode === "steer" || status === "active") {
        const detailed = await this.readThread(connection, params.threadId, true);
        const detailedThread = extractThread(detailed);
        // Active-turn ids may appear in full thread turns or the summary API;
        // try both before failing so steering handles materialized and lazy turns.
        const turnId =
          (detailedThread ? findInProgressTurnId(detailedThread) : undefined) ??
          findInProgressTurnId(thread) ??
          (await this.readActiveTurnId(connection, params.threadId));
        if (!turnId) {
          throw new Error(
            `Codex thread ${params.threadId} is active but no in-progress turn is readable`,
          );
        }
        await connection.request("turn/steer", {
          threadId: params.threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: params.text, text_elements: [] }],
        });
        return { endpointId, threadId: params.threadId, mode: "steer", turnId, status };
      }
      return await this.startTurn(connection, endpointId, params.threadId, params.text);
    } catch (error) {
      this.forgetEndpoint(endpointId);
      throw error;
    }
  }

  /** Interrupts an active Codex turn, resolving the turn id when omitted. */
  async interruptSession(params: {
    endpointId?: string;
    threadId: string;
    turnId?: string;
  }): Promise<{ endpointId: string; threadId: string; turnId: string }> {
    const endpointId = await this.resolveEndpointId(params);
    const connection = await this.connectionFor(endpointId);
    try {
      let turnId = params.turnId;
      if (!turnId) {
        const read = await this.readThread(connection, params.threadId, true);
        const thread = extractThread(read);
        turnId =
          (thread ? findInProgressTurnId(thread) : undefined) ??
          (await this.readActiveTurnId(connection, params.threadId));
      }
      if (!turnId) {
        throw new Error(`Codex thread ${params.threadId} has no readable in-progress turn`);
      }
      await connection.request("turn/interrupt", { threadId: params.threadId, turnId });
      return { endpointId, threadId: params.threadId, turnId };
    } catch (error) {
      this.forgetEndpoint(endpointId);
      throw error;
    }
  }

  private async listEndpointSessions(
    endpoint: CodexSupervisorEndpoint,
    params: { includeStored?: boolean; maxStoredSessions?: number },
  ): Promise<CodexSupervisorSession[]> {
    if (params.includeStored === true) {
      const loaded = await this.listLoadedThreadSessions(endpoint);
      const sessions = [...loaded];
      for (const stored of await this.listStoredThreadSessions(
        endpoint,
        params.maxStoredSessions,
      )) {
        // Loaded sessions are authoritative for attachment/status; append stored
        // history only for threads that are not already live.
        if (!sessions.some((session) => session.threadId === stored.threadId)) {
          sessions.push(stored);
        }
      }
      return sessions;
    }
    return await this.listLoadedThreadSessions(endpoint);
  }

  private async listLoadedThreadSessions(
    endpoint: CodexSupervisorEndpoint,
  ): Promise<CodexSupervisorSession[]> {
    const sessions: CodexSupervisorSession[] = [];
    const connection = await this.connectionFor(endpoint.id);
    let cursor: string | undefined;
    do {
      const listed = await connection.request("thread/loaded/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const threadId of extractStringList(listed)) {
        if (sessions.some((entry) => entry.threadId === threadId)) {
          continue;
        }
        const read = await this.readOptionalLoadedThread(connection, threadId);
        const thread = extractThread(read);
        const session = thread ? toSession(endpoint.id, thread, true) : undefined;
        if (session) {
          sessions.push(session);
        }
      }
      cursor =
        isRecord(listed) && typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
    } while (cursor);
    return sessions;
  }

  private async listStoredThreadSessions(
    endpoint: CodexSupervisorEndpoint,
    maxStoredSessions = DEFAULT_MAX_STORED_SESSIONS,
  ): Promise<CodexSupervisorSession[]> {
    const sessionLimit = Number.isFinite(maxStoredSessions)
      ? Math.min(1000, Math.max(1, Math.floor(maxStoredSessions)))
      : DEFAULT_MAX_STORED_SESSIONS;
    const sessions: CodexSupervisorSession[] = [];
    const connection = await this.connectionFor(endpoint.id);
    let cursor: string | undefined;
    do {
      const remaining = sessionLimit - sessions.length;
      if (remaining <= 0) {
        break;
      }
      const listed = await connection.request("thread/list", {
        limit: Math.min(100, remaining),
        sourceKinds: ALL_CODEX_THREAD_SOURCE_KINDS,
        modelProviders: [],
        sortKey: "recency_at",
        sortDirection: "desc",
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of extractThreadList(listed)) {
        if (typeof thread.id !== "string") {
          continue;
        }
        if (
          sessions.some((entry) => entry.endpointId === endpoint.id && entry.threadId === thread.id)
        ) {
          continue;
        }
        const session = toSession(endpoint.id, thread);
        if (session) {
          sessions.push(session);
          if (sessions.length >= sessionLimit) {
            break;
          }
        }
      }
      cursor =
        isRecord(listed) && typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
    } while (cursor);
    return sessions;
  }

  private async readOptionalLoadedThread(
    connection: CodexJsonRpcConnection,
    threadId: string,
  ): Promise<unknown> {
    try {
      return await this.readLoadedThread(connection, threadId, false);
    } catch (error) {
      if (isLoadedThreadReadMiss(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async readLoadedThread(
    connection: CodexJsonRpcConnection,
    threadId: string,
    includeTurns: boolean,
  ): Promise<unknown> {
    try {
      return await connection.request("thread/read", { threadId, includeTurns });
    } catch (error) {
      if (!includeTurns) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("not materialized yet")) {
        throw error;
      }
      return await connection.request("thread/read", { threadId, includeTurns: false });
    }
  }

  private async startTurn(
    connection: CodexJsonRpcConnection,
    endpointId: string,
    threadId: string,
    text: string,
  ): Promise<CodexSupervisorSendResult> {
    const result = await connection.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    const turn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
    return {
      endpointId,
      threadId,
      mode: "start",
      ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
      ...(typeof turn?.status === "string" ? { status: turn.status } : {}),
    };
  }

  private async readThread(
    connection: CodexJsonRpcConnection,
    threadId: string,
    includeTurns: boolean,
  ): Promise<unknown> {
    return await this.readLoadedThread(connection, threadId, includeTurns);
  }

  private async readActiveTurnId(
    connection: CodexJsonRpcConnection,
    threadId: string,
  ): Promise<string | undefined> {
    try {
      const response = await connection.request("thread/turns/list", {
        threadId,
        limit: 10,
        sortDirection: "desc",
        itemsView: "summary",
      });
      return extractThreadList(response).find(
        (turn) => turn.status === "inProgress" && typeof turn.id === "string",
      )?.id as string | undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveEndpointId(params: {
    endpointId?: string;
    threadId: string;
  }): Promise<string> {
    if (params.endpointId) {
      return params.endpointId;
    }
    const sessions = await this.listSessions();
    const matches = sessions.filter((session) => session.threadId === params.threadId);
    if (matches.length === 1) {
      return matches[0].endpointId;
    }
    if (matches.length > 1) {
      throw new Error(`Codex thread id is ambiguous across endpoints: ${params.threadId}`);
    }
    const endpointIds = new Set(matches.map((match) => match.endpointId));
    for (const endpoint of this.endpoints) {
      if (endpointIds.has(endpoint.id)) {
        continue;
      }
      try {
        const connection = await this.connectionFor(endpoint.id);
        const read = await this.readThread(connection, params.threadId, false);
        const thread = extractThread(read);
        if (thread?.id === params.threadId) {
          endpointIds.add(endpoint.id);
        }
      } catch (error) {
        if (isLoadedThreadReadMiss(error)) {
          continue;
        }
        this.forgetEndpoint(endpoint.id);
        continue;
      }
    }
    if (endpointIds.size === 1) {
      for (const endpointId of endpointIds) {
        return endpointId;
      }
    }
    if (endpointIds.size > 1) {
      throw new Error(`Codex thread id is ambiguous across endpoints: ${params.threadId}`);
    }
    throw new Error(`Codex thread not found: ${params.threadId}`);
  }

  private async connectionFor(endpointId: string): Promise<CodexJsonRpcConnection> {
    const endpoint = this.endpoints.find((entry) => entry.id === endpointId);
    if (!endpoint) {
      throw new Error(`Unknown Codex supervisor endpoint: ${endpointId}`);
    }
    const existing = this.connections.get(endpoint.id);
    if (existing) {
      return await existing;
    }
    const created = this.connector(endpoint);
    this.connections.set(endpoint.id, created);
    void created.catch(() => {
      if (this.connections.get(endpoint.id) === created) {
        this.connections.delete(endpoint.id);
      }
    });
    return await created;
  }

  private forgetEndpoint(endpointId: string): void {
    const existing = this.connections.get(endpointId);
    if (!existing) {
      return;
    }
    this.connections.delete(endpointId);
    void existing.then((connection) => connection.close()).catch(() => undefined);
  }
}
