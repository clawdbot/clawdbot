import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidget,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_BOARD_SCHEMA_SQL } from "../state/openclaw-agent-board-schema.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { normalizeBoardWidgetDeclared } from "./board-capabilities.js";
import { applyBoardOps, BoardValidationError, normalizeBoardLayout } from "./board-layout.js";
import {
  cloneBoardSnapshot,
  createBoardGrantSnapshot,
  createBoardWidgetPutSnapshot,
  type BoardStore,
  type BoardWidgetHtmlDocument,
  type BoardWidgetMcpAppDocument,
} from "./board-store.js";
import {
  effectiveGrantState,
  parseDescriptor,
  parseManifest,
  rowToTab,
  rowToWidget,
  serializeManifest,
  updateManifestHeightMode,
  type SelectedBoardTabRow,
  type SelectedBoardWidgetRow,
} from "./sqlite-board-codec.js";

type BoardDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets" | "session_entries"
>;
type BoardDatabaseHandle = Pick<OpenClawAgentDatabase, "db" | "path">;

type StoredBoard = {
  snapshot: BoardSnapshot;
  tabRows: SelectedBoardTabRow[];
  widgetRows: SelectedBoardWidgetRow[];
};

const ensuredBoardDatabases = new WeakSet<DatabaseSync>();

// Read-only connections cannot run the lazy DDL, and a pre-existing v13 DB has
// no board tables until the first write. Reads must treat that as "no boards",
// not "no such table".
function boardTablesPresent(database: Pick<OpenClawAgentDatabase, "db">): boolean {
  if (ensuredBoardDatabases.has(database.db)) {
    return true;
  }
  const row = database.db // sqlite-allow-raw: catalog probe before Kysely table access.
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_widgets'")
    .get();
  if (!row) {
    return false;
  }
  ensuredBoardDatabases.add(database.db);
  return true;
}

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
      const selectedWidgetRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("board_widgets")
          .selectAll()
          .where("session_key", "=", sessionKey)
          .orderBy("tab_id", "asc")
          .orderBy("position", "asc")
          .orderBy("name", "asc"),
      ).rows as SelectedBoardWidgetRow[];
      // Rows without the canonical authority snapshot predate this unreleased contract.
      // Keep them out of runtime state so they can never mint an interactive lease.
      const widgetRows = selectedWidgetRows.filter((row) => {
        if (row.content_kind !== "mcp-app") {
          return true;
        }
        const manifest = parseManifest(row.manifest);
        return manifest.mcpAppInteractive !== undefined && manifest.mcpAppInstanceId !== undefined;
      });
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

function updateWidgetHeightModes(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  ops: readonly BoardOp[],
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  for (const op of ops) {
    if (op.kind !== "widget_resize") {
      continue;
    }
    const row = previous.widgetRows.find((candidate) => candidate.name === op.name);
    if (!row) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("board_widgets")
        .set({ manifest: updateManifestHeightMode(row.manifest, op.heightMode ?? "fixed") })
        .where("session_key", "=", previous.snapshot.sessionKey)
        .where("name", "=", op.name),
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
  params: BoardWidgetMaterializedPutParams,
  // Effective frame options come from the materialized widget, not the raw put
  // params: re-pins that omit them must keep the inherited persisted values.
  frame: Pick<BoardWidget, "presentation" | "heightMode">,
  revision: number,
  grantState: BoardWidget["grantState"],
  viewGeneration: string,
  now: number,
) {
  const manifest = serializeManifest(
    params.declared,
    grantState,
    params.content.kind === "mcp-app"
      ? { interactive: params.content.interactive, instanceId: viewGeneration }
      : undefined,
    frame,
  );
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
        hasSession(database, resolved.sessionKey) && boardTablesPresent(database)
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
        updateWidgetHeightModes(transactionDatabase, previous, ops);
        deleteRemovedTabs(transactionDatabase, previous, next);
        return cloneBoardSnapshot(next);
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.apply-ops" },
    );
  }

  putWidget(params: BoardWidgetMaterializedPutParams): BoardSnapshot {
    const { database, resolved } = this.prepareWrite(params.sessionKey);
    const declared = normalizeBoardWidgetDeclared(params.declared);
    const canonicalParams: BoardWidgetMaterializedPutParams = {
      ...params,
      sessionKey: resolved.sessionKey,
    };
    if (declared) {
      canonicalParams.declared = declared;
    } else {
      delete canonicalParams.declared;
    }
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
        const existing = previous.widgetRows.find((row) => row.name === canonicalParams.name);
        const grantScopeMatches = existing
          ? existing.content_kind === "html"
            ? canonicalParams.content.kind === "html"
            : existing.descriptor_json !== null &&
              canonicalParams.content.kind === "mcp-app" &&
              parseDescriptor(existing.descriptor_json).serverName ===
                canonicalParams.content.descriptor.serverName
          : true;
        const next = createBoardWidgetPutSnapshot(previous.snapshot, canonicalParams, {
          grantScopeMatches,
          grantedSha256: existing?.granted_sha ?? undefined,
          instanceId: viewGeneration,
        });
        const widget = next.widgets.find((candidate) => candidate.name === canonicalParams.name)!;
        const now = Date.now();
        upsertTabs(transactionDatabase, previous, next);
        const db = getNodeSqliteKysely<BoardDatabase>(transactionDatabase.db);
        const fields = contentFields(
          canonicalParams,
          { presentation: widget.presentation, heightMode: widget.heightMode },
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
    instanceId?: string,
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
        const next = createBoardGrantSnapshot(
          previous.snapshot,
          name,
          decision,
          revision,
          instanceId,
        );
        upsertTabs(transactionDatabase, previous, next);
        const row = previous.widgetRows.find((candidate) => candidate.name === name)!;
        const manifest = parseManifest(row.manifest);
        const declared = manifest.declared;
        const db = getNodeSqliteKysely<BoardDatabase>(transactionDatabase.db);
        executeSqliteQuerySync(
          transactionDatabase.db,
          db
            .updateTable("board_widgets")
            .set({
              grant_state: decision,
              granted_sha: decision === "granted" ? row.sha256 : null,
              manifest: serializeManifest(
                declared,
                decision,
                manifest.mcpAppInteractive !== undefined && manifest.mcpAppInstanceId
                  ? {
                      interactive: manifest.mcpAppInteractive,
                      instanceId: manifest.mcpAppInstanceId,
                    }
                  : undefined,
                {
                  presentation: manifest.presentation,
                  heightMode: manifest.heightMode,
                },
              ),
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

  readWidgetHtml(sessionKey: string, name: string): BoardWidgetHtmlDocument | undefined {
    const resolved = this.resolve(sessionKey);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (!hasSession(database, resolved.sessionKey) || !boardTablesPresent(database)) {
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
              "manifest",
            ])
            .where("session_key", "=", resolved.sessionKey)
            .where("name", "=", name)
            .limit(1),
        ).rows[0];
        if (!row) {
          return undefined;
        }
        if (row.content_kind === "html" && row.html !== null && row.view_generation !== null) {
          const manifest = parseManifest(row.manifest);
          const declared = manifest.declared;
          return {
            html: Buffer.from(row.html).toString("utf8"),
            revision: row.revision,
            sha256: row.sha256,
            viewGeneration: row.view_generation,
            grantState: effectiveGrantState(row.grant_state as BoardWidget["grantState"], manifest),
            ...(declared ? { declared } : {}),
          };
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

  readWidgetMcpApp(sessionKey: string, name: string): BoardWidgetMcpAppDocument | undefined {
    const resolved = this.resolve(sessionKey);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (!hasSession(database, resolved.sessionKey) || !boardTablesPresent(database)) {
          return undefined;
        }
        const db = getNodeSqliteKysely<BoardDatabase>(database.db);
        const row = executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("board_widgets")
            .select(["content_kind", "descriptor_json", "revision", "grant_state", "manifest"])
            .where("session_key", "=", resolved.sessionKey)
            .where("name", "=", name)
            .limit(1),
        ).rows[0];
        if (!row || row.content_kind !== "mcp-app" || row.descriptor_json === null) {
          return undefined;
        }
        const manifest = parseManifest(row.manifest);
        if (manifest.mcpAppInteractive === undefined || manifest.mcpAppInstanceId === undefined) {
          return undefined;
        }
        return {
          descriptor: parseDescriptor(row.descriptor_json),
          revision: row.revision,
          instanceId: manifest.mcpAppInstanceId,
          grantState: effectiveGrantState(row.grant_state as BoardWidget["grantState"], manifest),
          declaredTools: manifest.declared?.tools ?? [],
          interactive: manifest.mcpAppInteractive,
        };
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
          if (!boardTablesPresent(database)) {
            return [];
          }
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
