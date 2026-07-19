import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type {
  BoardMcpAppDescriptor,
  BoardOp,
  BoardSnapshot,
  BoardTab,
  BoardWidget,
  BoardWidgetPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_BOARD_SCHEMA_SQL } from "../state/openclaw-agent-board-schema.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type {
  BoardTabs as BoardTabRow,
  BoardWidgets as BoardWidgetRow,
  DB as OpenClawAgentKyselyDatabase,
} from "../state/openclaw-agent-db.generated.js";
import {
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { applyBoardOps, BoardValidationError, normalizeBoardLayout } from "./board-layout.js";
import {
  cloneBoardSnapshot,
  createBoardDeclaredSummary,
  createBoardGrantSnapshot,
  createBoardWidgetPutSnapshot,
  type BoardStore,
  type BoardWidgetDocument,
} from "./board-store.js";

type BoardDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets" | "session_entries"
>;
type BoardDatabaseHandle = Pick<OpenClawAgentDatabase, "db" | "path">;
type SelectedBoardTabRow = Selectable<BoardTabRow>;
type SelectedBoardWidgetRow = Selectable<BoardWidgetRow>;

type StoredBoard = {
  snapshot: BoardSnapshot;
  tabRows: SelectedBoardTabRow[];
  widgetRows: SelectedBoardWidgetRow[];
};

const ensuredBoardDatabases = new WeakSet<DatabaseSync>();

function ensureBoardSchema(database: OpenClawAgentDatabase): void {
  if (ensuredBoardDatabases.has(database.db)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error("board schema must be ensured before the write transaction starts");
  }
  runSqliteImmediateTransactionSync(
    database.db,
    () => database.db.exec(OPENCLAW_AGENT_BOARD_SCHEMA_SQL), // sqlite-allow-raw: one-time DDL bootstrap before Kysely access.
    {
      databaseLabel: database.path,
      operationLabel: "board.ensure-schema",
    },
  );
  // Additive-surface rule: fold this into the next natural schema bump, then delete this lazy ensure.
  ensuredBoardDatabases.add(database.db);
}

type SqliteBoardStoreOptions = {
  resolveSession: (sessionKey: string) => {
    agentId: string;
    path?: string;
    sessionKey: string;
  };
  env?: NodeJS.ProcessEnv;
};

function parseManifest(value: string): BoardWidgetPutParams["declared"] {
  const parsed = JSON.parse(value) as { netOrigins?: unknown; tools?: unknown };
  const netOrigins = Array.isArray(parsed.netOrigins)
    ? parsed.netOrigins.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    ...(netOrigins?.length ? { netOrigins } : {}),
    ...(tools?.length ? { tools } : {}),
  };
}

function parseDescriptor(value: string): BoardMcpAppDescriptor {
  return JSON.parse(value) as BoardMcpAppDescriptor;
}

function rowToTab(row: SelectedBoardTabRow): BoardTab {
  return {
    tabId: row.tab_id,
    title: row.title,
    position: row.position,
    chatDock: row.chat_dock as BoardTab["chatDock"],
  };
}

function rowToWidget(row: SelectedBoardWidgetRow): BoardWidget {
  const declaredSummary = createBoardDeclaredSummary(parseManifest(row.manifest));
  return {
    name: row.name,
    tabId: row.tab_id,
    ...(row.title !== null ? { title: row.title } : {}),
    contentKind: row.content_kind as BoardWidget["contentKind"],
    sizeW: row.size_w,
    sizeH: row.size_h,
    position: row.position,
    grantState: row.grant_state as BoardWidget["grantState"],
    revision: row.revision,
    ...(declaredSummary ? { declaredSummary } : {}),
  };
}

function readStoredBoard(database: BoardDatabaseHandle, sessionKey: string): StoredBoard {
  // Write callers already hold an IMMEDIATE transaction; the shared helper nests
  // this consistent read as a savepoint instead of issuing a second BEGIN.
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getNodeSqliteKysely<BoardDatabase>(database.db);
      const tabRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("board_tabs")
          .selectAll()
          .where("session_key", "=", sessionKey)
          .orderBy("position", "asc")
          .orderBy("tab_id", "asc"),
      ).rows as SelectedBoardTabRow[];
      const widgetRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("board_widgets")
          .selectAll()
          .where("session_key", "=", sessionKey)
          .orderBy("tab_id", "asc")
          .orderBy("position", "asc")
          .orderBy("name", "asc"),
      ).rows as SelectedBoardWidgetRow[];
      const layout = normalizeBoardLayout({
        tabs: tabRows.map(rowToTab),
        widgets: widgetRows.map(rowToWidget),
      });
      return {
        snapshot: {
          sessionKey,
          // Board existence is row-defined; deleting the last empty tab removes
          // the board, so a later read starts again at the empty revision.
          revision: tabRows.reduce((revision, row) => Math.max(revision, row.revision), 0),
          ...layout,
        },
        tabRows,
        widgetRows,
      };
    },
    { databaseLabel: database.path, operationLabel: "board.read" },
  );
}

function upsertTabs(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  next: BoardSnapshot,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const createdBy = new Map(previous.tabRows.map((row) => [row.tab_id, row.created_by]));
  for (const tab of next.tabs) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("board_tabs")
        .values({
          session_key: next.sessionKey,
          tab_id: tab.tabId,
          title: tab.title,
          position: tab.position,
          chat_dock: tab.chatDock,
          created_by: createdBy.get(tab.tabId) ?? "agent",
          revision: next.revision,
        })
        .onConflict((conflict) =>
          conflict.columns(["session_key", "tab_id"]).doUpdateSet({
            title: tab.title,
            position: tab.position,
            chat_dock: tab.chatDock,
            revision: next.revision,
          }),
        ),
    );
  }
}

function updateWidgetLayouts(
  database: BoardDatabaseHandle,
  snapshot: BoardSnapshot,
  updatedAt: number,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  for (const widget of snapshot.widgets) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("board_widgets")
        .set({
          tab_id: widget.tabId,
          title: widget.title ?? null,
          size_w: widget.sizeW,
          size_h: widget.sizeH,
          position: widget.position,
          updated_at: updatedAt,
        })
        .where("session_key", "=", snapshot.sessionKey)
        .where("name", "=", widget.name),
    );
  }
}

function deleteRemovedWidgets(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  next: BoardSnapshot,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const widgetNames = new Set(next.widgets.map((widget) => widget.name));
  for (const row of previous.widgetRows) {
    if (!widgetNames.has(row.name)) {
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("board_widgets")
          .where("session_key", "=", next.sessionKey)
          .where("name", "=", row.name),
      );
    }
  }
}

function deleteRemovedTabs(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  next: BoardSnapshot,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const tabIds = new Set(next.tabs.map((tab) => tab.tabId));
  for (const row of previous.tabRows) {
    if (!tabIds.has(row.tab_id)) {
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("board_tabs")
          .where("session_key", "=", next.sessionKey)
          .where("tab_id", "=", row.tab_id),
      );
    }
  }
}

function contentFields(
  params: BoardWidgetPutParams,
  revision: number,
  grantState: BoardWidget["grantState"],
  viewGeneration: string,
  now: number,
) {
  const manifest = JSON.stringify(params.declared ?? {});
  if (params.content.kind === "html") {
    const sha256 = createHash("sha256").update(params.content.html).digest("hex");
    return {
      content_kind: "html",
      html: Buffer.from(params.content.html, "utf8"),
      descriptor_json: null,
      sha256,
      view_generation: viewGeneration,
      revision,
      manifest,
      grant_state: grantState,
      granted_sha: grantState === "granted" ? sha256 : null,
      updated_at: now,
    };
  }
  const descriptorJson = JSON.stringify(params.content.descriptor);
  const sha256 = createHash("sha256").update(descriptorJson).digest("hex");
  return {
    content_kind: "mcp-app",
    html: null,
    descriptor_json: descriptorJson,
    sha256,
    view_generation: null,
    revision,
    manifest,
    grant_state: grantState,
    granted_sha: grantState === "granted" ? sha256 : null,
    updated_at: now,
  };
}

function hasSession(database: BoardDatabaseHandle, sessionKey: string): boolean {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  return Boolean(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_entries")
        .select("session_key")
        .where("session_key", "=", sessionKey)
        .limit(1),
    ).rows[0],
  );
}

function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

export class SqliteBoardStore implements BoardStore {
  constructor(private readonly options: SqliteBoardStoreOptions) {}

  private resolve(sessionKey: string): { agentId: string; path?: string; sessionKey: string } {
    return this.options.resolveSession(sessionKey);
  }

  private requireExistingSession(resolved: {
    agentId: string;
    path?: string;
    sessionKey: string;
  }): void {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => hasSession(database, resolved.sessionKey),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
      },
    );
    if (!result.found || !result.value) {
      throw new BoardValidationError(
        "not_found",
        `board session not found: ${resolved.sessionKey}`,
      );
    }
  }

  private prepareWrite(sessionKey: string): {
    database: OpenClawAgentDatabase;
    resolved: { agentId: string; path?: string; sessionKey: string };
  } {
    const resolved = this.resolve(sessionKey);
    this.requireExistingSession(resolved);
    const database = openOpenClawAgentDatabase({
      agentId: resolved.agentId,
      ...(resolved.path ? { path: resolved.path } : {}),
      env: this.options.env,
    });
    ensureBoardSchema(database);
    return { database, resolved };
  }

  getSnapshot(sessionKey: string): BoardSnapshot {
    const resolved = this.resolve(sessionKey);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        hasSession(database, resolved.sessionKey)
          ? readStoredBoard(database, resolved.sessionKey).snapshot
          : undefined,
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
      },
    );
    return cloneBoardSnapshot(
      result.found && result.value ? result.value : emptyBoardSnapshot(resolved.sessionKey),
    );
  }

  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot {
    if (ops.length === 0) {
      return this.getSnapshot(sessionKey);
    }
    const { database, resolved } = this.prepareWrite(sessionKey);
    return runOpenClawAgentWriteTransaction(
      (transactionDatabase) => {
        if (!hasSession(transactionDatabase, resolved.sessionKey)) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const previous = readStoredBoard(transactionDatabase, resolved.sessionKey);
        const layout = applyBoardOps(previous.snapshot, ops);
        const next: BoardSnapshot = {
          sessionKey: resolved.sessionKey,
          revision: previous.snapshot.revision + 1,
          ...layout,
        };
        const now = Date.now();
        upsertTabs(transactionDatabase, previous, next);
        deleteRemovedWidgets(transactionDatabase, previous, next);
        updateWidgetLayouts(transactionDatabase, next, now);
        deleteRemovedTabs(transactionDatabase, previous, next);
        return cloneBoardSnapshot(next);
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.apply-ops" },
    );
  }

  putWidget(params: BoardWidgetPutParams): BoardSnapshot {
    const { database, resolved } = this.prepareWrite(params.sessionKey);
    const canonicalParams = { ...params, sessionKey: resolved.sessionKey };
    const viewGeneration = randomBytes(16).toString("hex");
    return runOpenClawAgentWriteTransaction(
      (transactionDatabase) => {
        if (!hasSession(transactionDatabase, resolved.sessionKey)) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const previous = readStoredBoard(transactionDatabase, resolved.sessionKey);
        const next = createBoardWidgetPutSnapshot(previous.snapshot, canonicalParams);
        const widget = next.widgets.find((candidate) => candidate.name === canonicalParams.name)!;
        const existing = previous.widgetRows.find((row) => row.name === canonicalParams.name);
        const now = Date.now();
        upsertTabs(transactionDatabase, previous, next);
        const db = getNodeSqliteKysely<BoardDatabase>(transactionDatabase.db);
        const fields = contentFields(
          canonicalParams,
          widget.revision,
          widget.grantState,
          viewGeneration,
          now,
        );
        executeSqliteQuerySync(
          transactionDatabase.db,
          db
            .insertInto("board_widgets")
            .values({
              session_key: resolved.sessionKey,
              name: canonicalParams.name,
              tab_id: widget.tabId,
              title: widget.title ?? null,
              size_w: widget.sizeW,
              size_h: widget.sizeH,
              position: widget.position,
              created_by: existing?.created_by ?? "agent",
              created_at: existing?.created_at ?? now,
              ...fields,
            })
            .onConflict((conflict) =>
              conflict.columns(["session_key", "name"]).doUpdateSet({
                tab_id: widget.tabId,
                title: widget.title ?? null,
                size_w: widget.sizeW,
                size_h: widget.sizeH,
                position: widget.position,
                ...fields,
              }),
            ),
        );
        updateWidgetLayouts(transactionDatabase, next, now);
        return cloneBoardSnapshot(next);
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.put-widget" },
    );
  }

  grant(
    sessionKey: string,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
  ): BoardSnapshot {
    const { database, resolved } = this.prepareWrite(sessionKey);
    return runOpenClawAgentWriteTransaction(
      (transactionDatabase) => {
        if (!hasSession(transactionDatabase, resolved.sessionKey)) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const previous = readStoredBoard(transactionDatabase, resolved.sessionKey);
        const next = createBoardGrantSnapshot(previous.snapshot, name, decision, revision);
        upsertTabs(transactionDatabase, previous, next);
        const row = previous.widgetRows.find((candidate) => candidate.name === name)!;
        const db = getNodeSqliteKysely<BoardDatabase>(transactionDatabase.db);
        executeSqliteQuerySync(
          transactionDatabase.db,
          db
            .updateTable("board_widgets")
            .set({
              grant_state: decision,
              granted_sha: decision === "granted" ? row.sha256 : null,
              updated_at: Date.now(),
            })
            .where("session_key", "=", resolved.sessionKey)
            .where("name", "=", name),
        );
        return cloneBoardSnapshot(next);
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.grant-widget" },
    );
  }

  readWidgetHtml(sessionKey: string, name: string): BoardWidgetDocument | undefined {
    const resolved = this.resolve(sessionKey);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (!hasSession(database, resolved.sessionKey)) {
          return undefined;
        }
        const db = getNodeSqliteKysely<BoardDatabase>(database.db);
        const row = executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("board_widgets")
            .select([
              "content_kind",
              "html",
              "descriptor_json",
              "revision",
              "sha256",
              "view_generation",
              "grant_state",
            ])
            .where("session_key", "=", resolved.sessionKey)
            .where("name", "=", name)
            .limit(1),
        ).rows[0];
        if (!row) {
          return undefined;
        }
        if (row.content_kind === "html" && row.html !== null && row.view_generation !== null) {
          return {
            html: Buffer.from(row.html).toString("utf8"),
            revision: row.revision,
            sha256: row.sha256,
            viewGeneration: row.view_generation,
            grantState: row.grant_state as BoardWidget["grantState"],
          };
        }
        if (row.content_kind === "mcp-app" && row.descriptor_json !== null) {
          return { descriptor: parseDescriptor(row.descriptor_json), revision: row.revision };
        }
        return undefined;
      },
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
      },
    );
    return result.found ? result.value : undefined;
  }

  listSessionsWithBoards(): string[] {
    const sessionKeys = new Set<string>();
    const agentIds = new Set(
      listOpenClawRegisteredAgentDatabases({ env: this.options.env }).map(
        (registered) => registered.agentId,
      ),
    );
    for (const agentId of agentIds) {
      const canonicalPath =
        this.resolve(`agent:${agentId}:main`).path ??
        resolveOpenClawAgentSqlitePath({ agentId, env: this.options.env });
      const result = withOpenClawAgentDatabaseReadOnly(
        (database) => {
          const db = getNodeSqliteKysely<BoardDatabase>(database.db);
          return executeSqliteQuerySync(
            database.db,
            db.selectFrom("board_tabs").select("session_key").distinct(),
          ).rows;
        },
        { agentId, path: canonicalPath, env: this.options.env },
      );
      if (result.found) {
        for (const row of result.value) {
          sessionKeys.add(row.session_key);
        }
      }
    }
    return [...sessionKeys].toSorted();
  }
}
