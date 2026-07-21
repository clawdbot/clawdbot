import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { InMemoryBoardStore, type BoardStore } from "./board-store.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function seedSession(env: NodeJS.ProcessEnv, agentId: string, sessionKey: string): string {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const sessionId = `session-${agentId}-${sessionKey.replaceAll(":", "-")}`;
  replaceSessionEntrySync(
    { agentId, sessionKey, storePath: database.path },
    { sessionId, updatedAt: Date.now() },
  );
  return database.path;
}

function createSqliteStore(): BoardStore {
  const stateDir = tempDirs.make("openclaw-board-parity-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  seedSession(env, "main", "agent:main:board");
  return new SqliteBoardStore({
    resolveSession: (sessionKey) => ({
      agentId: sessionKey.split(":")[1] ?? "main",
      sessionKey,
    }),
    env,
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe.each([
  ["memory", () => new InMemoryBoardStore()],
  ["sqlite", createSqliteStore],
] as const)("BoardStore parity: %s", (_kind, createStore) => {
  it("persists revisions, layout, bytes, and declared summaries", () => {
    const store = createStore();
    const first = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: { kind: "html", html: "<p>one</p>" },
      presentation: "frameless",
      heightMode: "auto",
      declared: {
        netOrigins: ["https://weather.example"],
        tools: ["weather.refresh"],
      },
    });
    expect(first).toMatchObject({
      revision: 1,
      tabs: [{ tabId: "main", position: 0 }],
      widgets: [
        {
          name: "weather",
          revision: 1,
          grantState: "pending",
          presentation: "frameless",
          heightMode: "auto",
          declaredSummary: [
            "Network access: https://weather.example",
            "Tool access: weather.refresh",
          ],
          declared: {
            netOrigins: ["https://weather.example"],
            tools: ["weather.refresh"],
          },
        },
      ],
    });
    expect(store.readWidgetHtml("agent:main:board", "weather")).toMatchObject({
      html: "<p>one</p>",
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    // Legacy clients omit heightMode on resize; explicit user sizing must pin.
    const resized = store.applyOps("agent:main:board", [
      { kind: "widget_resize", name: "weather", sizeW: 8, sizeH: 6 },
    ]);
    expect(resized).toMatchObject({
      revision: 2,
      widgets: [
        {
          sizeW: 8,
          sizeH: 6,
          revision: 1,
          presentation: "frameless",
          heightMode: "fixed",
        },
      ],
    });
    expect(
      store.grant("agent:main:board", "weather", "granted", 1, first.widgets[0]?.instanceId),
    ).toMatchObject({
      revision: 3,
      widgets: [{ grantState: "granted" }],
    });

    const updated = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: { kind: "html", html: "<p>two</p>" },
    });
    expect(updated).toMatchObject({
      revision: 4,
      widgets: [
        {
          revision: 2,
          grantState: "none",
          sizeW: 8,
          sizeH: 6,
          presentation: "frameless",
          heightMode: "fixed",
        },
      ],
    });
    expect(updated.widgets[0]).not.toHaveProperty("declaredSummary");
    expect(store.getSnapshot("agent:main:board").widgets[0]).not.toHaveProperty("declaredSummary");
    expect(updated.widgets[0]).not.toHaveProperty("declared");
  });

  it("keeps content-kind semantics and normalized ordering", () => {
    const store = createStore();
    store.applyOps("agent:main:board", [
      { kind: "tab_create", tabId: "main", title: "Main" },
      { kind: "tab_create", tabId: "notes", title: "Notes" },
    ]);
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "first",
      content: { kind: "html", html: "first" },
    });
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          toolCallId: "call",
        },
        interactive: true,
      },
      placement: { tabId: "notes" },
    });
    expect(store.getSnapshot("agent:main:board").widgets).toEqual([
      expect.objectContaining({ name: "first", tabId: "main", position: 0 }),
      expect.objectContaining({ name: "app", tabId: "notes", position: 0 }),
    ]);
    expect(store.readWidgetHtml("agent:main:board", "app")).toBeUndefined();
    expect(store.readWidgetMcpApp("agent:main:board", "app")).toMatchObject({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      revision: 1,
      instanceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      interactive: true,
    });
    expect(store.getSnapshot("agent:main:board").widgets[1]?.instanceId).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("preserves grants only for unchanged bytes with equal or narrower declarations", () => {
    const store = createStore();
    const first = store.putWidget({
      sessionKey: "agent:main:board",
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: {
        netOrigins: ["https://one.example", "https://two.example"],
        tools: ["weather.read", "weather.refresh"],
      },
    });
    store.grant("agent:main:board", "scoped", "granted", 1, first.widgets[0]?.instanceId);

    const equal = store.putWidget({
      sessionKey: "agent:main:board",
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: {
        netOrigins: ["https://one.example", "https://two.example"],
        tools: ["weather.read", "weather.refresh"],
      },
    });
    expect(equal.widgets[0]).toMatchObject({ revision: 2, grantState: "granted" });
    expect(store.readWidgetHtml("agent:main:board", "scoped")).toMatchObject({
      html: "one",
      grantState: "granted",
    });

    const narrower = store.putWidget({
      sessionKey: "agent:main:board",
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: {
        netOrigins: ["https://one.example"],
        tools: ["weather.read"],
      },
    });
    expect(narrower.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });

    const changed = store.putWidget({
      sessionKey: "agent:main:board",
      name: "scoped",
      content: { kind: "html", html: "two" },
      declared: {
        netOrigins: ["https://one.example"],
        tools: ["weather.read"],
      },
    });
    expect(changed.widgets[0]).toMatchObject({ revision: 4, grantState: "pending" });
    expect(store.readWidgetHtml("agent:main:board", "scoped")).toMatchObject({
      html: "two",
      grantState: "pending",
    });
    store.grant("agent:main:board", "scoped", "granted", 4, changed.widgets[0]?.instanceId);

    const wider = store.putWidget({
      sessionKey: "agent:main:board",
      name: "scoped",
      content: { kind: "html", html: "two" },
      declared: {
        netOrigins: ["https://one.example", "https://three.example"],
        tools: ["weather.read"],
      },
    });
    expect(wider.widgets[0]).toMatchObject({ revision: 5, grantState: "pending" });
  });

  it("requires a fresh grant when an MCP app widget changes servers", () => {
    const store = createStore();
    const descriptor = {
      serverName: "server-a",
      toolName: "weather",
      uiResourceUri: "ui://weather",
      toolCallId: "call-a",
    };
    const first = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: { kind: "mcp-app", descriptor, interactive: true },
      declared: { tools: ["refresh"] },
    });
    store.grant("agent:main:board", "weather", "granted", 1, first.widgets[0]?.instanceId);

    const differentServer = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: {
        kind: "mcp-app",
        descriptor: { ...descriptor, serverName: "server-b", toolCallId: "call-b" },
        interactive: true,
      },
      declared: { tools: ["refresh"] },
    });
    expect(differentServer.widgets[0]).toMatchObject({ revision: 2, grantState: "pending" });

    store.grant(
      "agent:main:board",
      "weather",
      "granted",
      2,
      differentServer.widgets[0]?.instanceId,
    );
    const sameServer = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: {
        kind: "mcp-app",
        descriptor: { ...descriptor, serverName: "server-b", toolCallId: "call-c" },
        interactive: true,
      },
      declared: { tools: ["refresh"] },
    });
    expect(sameServer.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });
  });

  it("rejects a delayed MCP App grant after remove and same-name replacement", () => {
    const store = createStore();
    const putApp = (serverName: string) =>
      store.putWidget({
        sessionKey: "agent:main:board",
        name: "app",
        content: {
          kind: "mcp-app",
          descriptor: {
            serverName,
            toolName: "tool",
            uiResourceUri: `ui://${serverName}`,
            toolCallId: `call-${serverName}`,
          },
          interactive: true,
        },
        declared: { tools: ["refresh"] },
      });
    const original = putApp("server-a");
    store.applyOps("agent:main:board", [{ kind: "widget_remove", name: "app" }]);
    const replacement = putApp("server-b");

    expect(replacement.widgets[0]).toMatchObject({ revision: 1, grantState: "pending" });
    expect(replacement.widgets[0]?.instanceId).not.toBe(original.widgets[0]?.instanceId);
    expect(() =>
      store.grant("agent:main:board", "app", "granted", 1, original.widgets[0]?.instanceId),
    ).toThrow("instance changed");
    expect(
      store.grant("agent:main:board", "app", "granted", 1, replacement.widgets[0]?.instanceId)
        .widgets[0],
    ).toMatchObject({ grantState: "granted" });
  });

  it("rejects a delayed HTML grant after remove and same-name replacement", () => {
    const store = createStore();
    const putHtml = (html: string) =>
      store.putWidget({
        sessionKey: "agent:main:board",
        name: "app",
        content: { kind: "html", html },
        declared: { tools: ["refresh"] },
      });
    const original = putHtml("original");
    store.applyOps("agent:main:board", [{ kind: "widget_remove", name: "app" }]);
    const replacement = putHtml("replacement");

    expect(replacement.widgets[0]).toMatchObject({ revision: 1, grantState: "pending" });
    expect(replacement.widgets[0]?.instanceId).not.toBe(original.widgets[0]?.instanceId);
    expect(() =>
      store.grant("agent:main:board", "app", "granted", 1, original.widgets[0]?.instanceId),
    ).toThrow("instance changed");
  });

  it("rejects stale grant revisions before accepting the current one", () => {
    const store = createStore();
    const first = store.putWidget({
      sessionKey: "agent:main:board",
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: { tools: ["weather.read"] },
    });
    expect(() => store.grant("agent:main:board", "scoped", "granted", 2)).toThrow(
      "revision changed",
    );
    expect(
      store.grant("agent:main:board", "scoped", "granted", 1, first.widgets[0]?.instanceId)
        .widgets[0],
    ).toMatchObject({
      revision: 1,
      grantState: "granted",
    });
  });

  it("drops an empty board after its last tab is deleted", () => {
    const store = createStore();
    store.applyOps("agent:main:board", [{ kind: "tab_create", tabId: "main", title: "Main" }]);
    expect(
      store.applyOps("agent:main:board", [{ kind: "tab_delete", tabId: "main" }]),
    ).toMatchObject({ revision: 2, tabs: [], widgets: [] });
    expect(store.getSnapshot("agent:main:board").revision).toBe(0);
    expect(store.listSessionsWithBoards()).toEqual([]);
  });
});

describe("SqliteBoardStore persistence", () => {
  it("round-trips widget frame preferences through the manifest", () => {
    const stateDir = tempDirs.make("openclaw-board-widget-frame-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:widget-frame";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "status" },
      presentation: "card",
      heightMode: "auto",
    });
    store.applyOps(sessionKey, [
      { kind: "widget_resize", name: "status", sizeW: 8, sizeH: 7, heightMode: "fixed" },
    ]);

    expect(store.getSnapshot(sessionKey).widgets[0]).toMatchObject({
      presentation: "card",
      heightMode: "fixed",
      sizeW: 8,
      sizeH: 7,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const readManifest = () =>
      JSON.parse(
        (
          database.db
            .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
            .get(sessionKey) as { manifest: string }
        ).manifest,
      );
    expect(readManifest()).toMatchObject({ presentation: "card", heightMode: "fixed" });

    // A content re-pin that omits frame options must keep the persisted ones.
    store.putWidget({ sessionKey, name: "status", content: { kind: "html", html: "status v2" } });
    expect(readManifest()).toMatchObject({ presentation: "card", heightMode: "fixed" });

    // Legacy resize ops without heightMode still pin persisted height.
    store.applyOps(sessionKey, [
      { kind: "widget_resize", name: "status", sizeW: 8, sizeH: 7, heightMode: "auto" },
    ]);
    expect(readManifest()).toMatchObject({ heightMode: "auto" });
    store.applyOps(sessionKey, [{ kind: "widget_resize", name: "status", sizeW: 6, sizeH: 4 }]);
    expect(readManifest()).toMatchObject({ presentation: "card", heightMode: "fixed" });
  });

  it("drops MCP App rows without canonical authority provenance", () => {
    const stateDir = tempDirs.make("openclaw-board-noncanonical-app-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:board";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    store.putWidget({
      sessionKey,
      name: "legacy-app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          toolCallId: "call",
        },
        interactive: true,
      },
      declared: { tools: ["refresh"] },
    });

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE board_widgets SET manifest = '{}' WHERE session_key = ? AND name = ?")
      .run(sessionKey, "legacy-app");

    expect(store.getSnapshot(sessionKey).widgets).toEqual([]);
    expect(store.readWidgetMcpApp(sessionKey, "legacy-app")).toBeUndefined();
  });

  it("lazily creates board tables for an existing v13 database", () => {
    const stateDir = tempDirs.make("openclaw-board-lazy-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:board";
    seedSession(env, "main", sessionKey);
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const existingV13 = new DatabaseSync(databasePath);
    existingV13.exec(`
      DROP TABLE board_widgets;
      DROP TABLE board_tabs;
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
    existingV13.close();

    const reopened = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'board_tabs'")
        .get(),
    ).toBeUndefined();

    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    // Reads before any write must see "no boards", not "no such table".
    expect(store.getSnapshot(sessionKey)).toMatchObject({ revision: 0, tabs: [], widgets: [] });
    expect(store.readWidgetHtml(sessionKey, "status")).toBeUndefined();
    expect(store.listSessionsWithBoards()).toEqual([]);
    expect(() =>
      store.putWidget({
        sessionKey,
        name: "broken",
        content: { kind: "html", html: "broken" },
        placement: { tabId: "missing" },
      }),
    ).toThrow("board tab not found");
    store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('board_tabs', 'board_widgets') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "board_tabs" }, { name: "board_widgets" }]);
    expect(
      reopened.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'board_widgets'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_board_widgets_tab_position'",
        )
        .get(),
    ).toEqual({ name: "idx_agent_board_widgets_tab_position" });
  });

  it("does not create an unregistered agent database during widget byte lookup", () => {
    const stateDir = tempDirs.make("openclaw-board-no-create-");
    const store = new SqliteBoardStore({
      resolveSession: () => ({
        agentId: "attacker-selected",
        sessionKey: "agent:attacker-selected:main",
      }),
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(store.getSnapshot("agent:attacker-selected:main")).toEqual({
      sessionKey: "agent:attacker-selected:main",
      revision: 0,
      tabs: [],
      widgets: [],
    });
    expect(store.readWidgetHtml("agent:attacker-selected:main", "missing")).toBeUndefined();
    expect(() =>
      store.putWidget({
        sessionKey: "agent:attacker-selected:main",
        name: "missing",
        content: { kind: "html", html: "no" },
      }),
    ).toThrow("board session not found");
    expect(
      existsSync(
        path.join(stateDir, "agents", "attacker-selected", "agent", "openclaw-agent.sqlite"),
      ),
    ).toBe(false);
    expect(existsSync(path.join(stateDir, "agents", "attacker-selected"))).toBe(false);
  });

  it("canonicalizes aliases before reading and writing board rows", () => {
    const stateDir = tempDirs.make("openclaw-board-alias-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const canonicalSessionKey = "agent:main:main";
    seedSession(env, "main", canonicalSessionKey);
    const store = new SqliteBoardStore({
      resolveSession: (sessionKey) => ({
        agentId: "main",
        sessionKey: sessionKey === "main" ? canonicalSessionKey : sessionKey,
      }),
      env,
    });

    store.putWidget({
      sessionKey: "main",
      name: "status",
      content: { kind: "html", html: "one" },
    });
    expect(store.getSnapshot(canonicalSessionKey)).toMatchObject({
      sessionKey: canonicalSessionKey,
      widgets: [{ name: "status", revision: 1 }],
    });
    store.putWidget({
      sessionKey: canonicalSessionKey,
      name: "status",
      content: { kind: "html", html: "two" },
    });
    expect(store.getSnapshot("main")).toMatchObject({
      sessionKey: canonicalSessionKey,
      widgets: [{ name: "status", revision: 2 }],
    });
    expect(store.listSessionsWithBoards()).toEqual([canonicalSessionKey]);
  });

  it("fails closed when reading a persisted unsafe capability manifest", () => {
    const stateDir = tempDirs.make("openclaw-board-unsafe-manifest-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:unsafe-manifest";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = ?, grant_state = 'granted', granted_sha = sha256 WHERE session_key = ? AND name = 'status'",
      )
      .run(
        JSON.stringify({ netOrigins: ["http://legacy.example"], tools: ["health"] }),
        sessionKey,
      );

    expect(store.getSnapshot(sessionKey).widgets[0]).toMatchObject({
      name: "status",
      grantState: "none",
    });
    expect(store.getSnapshot(sessionKey).widgets[0]).not.toHaveProperty("declared");
    expect(store.readWidgetHtml(sessionKey, "status")).toMatchObject({
      html: "ok",
      grantState: "none",
    });
    expect(store.readWidgetHtml(sessionKey, "status")).not.toHaveProperty("declared");

    database.db
      .prepare(
        "UPDATE board_widgets SET grant_state = 'rejected' WHERE session_key = ? AND name = 'status'",
      )
      .run(sessionKey);
    expect(store.getSnapshot(sessionKey).widgets[0]).toMatchObject({
      name: "status",
      grantState: "rejected",
    });
    expect(store.readWidgetHtml(sessionKey, "status")).toMatchObject({
      html: "ok",
      grantState: "rejected",
    });
  });

  it("reads widget bytes only from the canonical per-agent database", () => {
    const stateDir = tempDirs.make("openclaw-board-canonical-bytes-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:board";
    seedSession(env, agentId, sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId, sessionKey }),
      env,
    });
    store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "canonical" },
    });

    const relocated = openOpenClawAgentDatabase({
      agentId,
      env,
      path: path.join(stateDir, "000-relocated.sqlite"),
    });
    replaceSessionEntrySync(
      { agentId, sessionKey, storePath: relocated.path },
      { sessionId: "relocated-session", updatedAt: Date.now() },
    );
    relocated.db
      .prepare(
        "INSERT INTO board_tabs (session_key, tab_id, title, position, chat_dock, created_by, revision) VALUES (?, 'main', 'Main', 0, 'right', 'agent', 1)",
      )
      .run(sessionKey);
    relocated.db
      .prepare(
        "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, manifest, grant_state, created_by, created_at, updated_at) VALUES (?, 'status', 'main', 'html', ?, ?, ?, 1, 6, 4, 0, '{}', 'none', 'agent', 1, 1)",
      )
      .run(sessionKey, Buffer.from("relocated"), "a".repeat(64), "b".repeat(32));

    expect(store.readWidgetHtml(sessionKey, "status")).toMatchObject({ html: "canonical" });
  });

  it("purges board rows through the shared session deletion lifecycle", async () => {
    const stateDir = tempDirs.make("openclaw-board-shared-delete-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:cleanup";
    const databasePath = seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });

    const result = await deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      storePath: databasePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result.deleted).toBe(true);
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(database.db.prepare("SELECT count(*) AS count FROM board_widgets").get()).toEqual({
      count: 0,
    });
    expect(database.db.prepare("SELECT count(*) AS count FROM board_tabs").get()).toEqual({
      count: 0,
    });
  });

  it("clears a frozen grant when the widget digest changes", () => {
    const stateDir = tempDirs.make("openclaw-board-granted-digest-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:grant-digest";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    const first = store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "one" },
      declared: { tools: ["status.read", "status.refresh"] },
    });
    store.grant(sessionKey, "status", "granted", 1, first.widgets[0]?.instanceId);
    store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "two" },
      declared: { tools: ["status.read"] },
    });

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(
      database.db
        .prepare(
          "SELECT grant_state AS grantState, granted_sha AS grantedSha, sha256 FROM board_widgets WHERE session_key = ? AND name = 'status'",
        )
        .get(sessionKey),
    ).toEqual({
      grantState: "pending",
      grantedSha: null,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("requires reapproval for grants stored before byte-frozen semantics", () => {
    const stateDir = tempDirs.make("openclaw-board-legacy-grant-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:legacy-grant";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    const current = store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "approved" },
      declared: { tools: ["health"] },
    });
    store.grant(sessionKey, "status", "granted", 1, current.widgets[0]?.instanceId);

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE board_widgets SET manifest = ? WHERE session_key = ? AND name = 'status'")
      .run(JSON.stringify({ tools: ["health"] }), sessionKey);

    expect(store.getSnapshot(sessionKey).widgets[0]).toMatchObject({
      grantState: "pending",
      declared: { tools: ["health"] },
    });
    expect(store.readWidgetHtml(sessionKey, "status")).toMatchObject({
      grantState: "pending",
      declared: { tools: ["health"] },
    });
    expect(
      store.grant(sessionKey, "status", "granted", 1, current.widgets[0]?.instanceId).widgets[0],
    ).toMatchObject({ grantState: "granted" });
    expect(
      JSON.parse(
        (
          database.db
            .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
            .get(sessionKey) as { manifest: string }
        ).manifest,
      ),
    ).toEqual({ tools: ["health"], grantSemanticsVersion: 2 });
  });

  it("reopens durable boards and isolates owning agent databases", () => {
    const stateDir = tempDirs.make("openclaw-board-durable-");
    const options = {
      resolveSession: (sessionKey: string) => ({
        agentId: sessionKey.split(":")[1] ?? "main",
        sessionKey,
      }),
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    seedSession(options.env, "alpha", "agent:alpha:board");
    seedSession(options.env, "beta", "agent:beta:board");
    const store = new SqliteBoardStore(options);
    store.putWidget({
      sessionKey: "agent:alpha:board",
      name: "alpha",
      content: { kind: "html", html: "alpha" },
    });
    store.putWidget({
      sessionKey: "agent:beta:board",
      name: "beta",
      content: { kind: "html", html: "beta" },
    });

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const reopened = new SqliteBoardStore(options);
    expect(reopened.getSnapshot("agent:alpha:board").widgets).toEqual([
      expect.objectContaining({ name: "alpha", revision: 1 }),
    ]);
    expect(reopened.getSnapshot("agent:beta:board").widgets).toEqual([
      expect.objectContaining({ name: "beta", revision: 1 }),
    ]);
    expect(reopened.listSessionsWithBoards()).toEqual(["agent:alpha:board", "agent:beta:board"]);
  });
});
