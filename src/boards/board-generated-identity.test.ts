import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { BoardStore } from "./board-store.js";
import { createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function seedSession(env: NodeJS.ProcessEnv, sessionKey: string): void {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: database.path },
    { sessionId: `session-${sessionKey.replaceAll(":", "-")}`, updatedAt: Date.now() },
  );
}

function createSqliteStore(): BoardStore {
  return createTestBoardStore();
}

function generatedIdentity(key: string, fallbackName: string) {
  return {
    source: "show_widget" as const,
    key: key.repeat(64),
    fallbackName,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("generated BoardStore identity", () => {
  const createStore = createSqliteStore;
  it("keeps colliding titles distinct and canonical spellings stable", () => {
    const store = createStore();
    const composed = store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Café Menu",
      content: { kind: "html", html: "<p>accented</p>" },
      generatedIdentity: generatedIdentity("a", "cafe-menu-aaaaaaaa"),
    });
    expect(composed.resolvedWidgetName).toBe("cafe-menu");

    const decomposed = store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Cafe\u0301 Menu",
      content: { kind: "html", html: "<p>accented revised</p>" },
      generatedIdentity: generatedIdentity("a", "cafe-menu-aaaaaaaa"),
    });
    expect(decomposed).toMatchObject({
      resolvedWidgetName: "cafe-menu",
      widgets: [{ name: "cafe-menu", revision: 2 }],
    });

    const plain = store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Cafe Menu",
      content: { kind: "html", html: "<p>plain</p>" },
      generatedIdentity: generatedIdentity("b", "cafe-menu-bbbbbbbb"),
    });
    expect(plain.resolvedWidgetName).toBe("cafe-menu-bbbbbbbb");
    expect(plain.widgets.map((widget) => widget.name)).toEqual(["cafe-menu", "cafe-menu-bbbbbbbb"]);
    expect(store.readWidgetHtml("agent:main:board", "cafe-menu")?.html).toContain(
      "accented revised",
    );

    const plainUpdate = store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Cafe Menu",
      content: { kind: "html", html: "<p>plain revised</p>" },
      generatedIdentity: generatedIdentity("b", "cafe-menu-bbbbbbbb"),
    });
    expect(plainUpdate).toMatchObject({
      resolvedWidgetName: "cafe-menu-bbbbbbbb",
      widgets: [
        { name: "cafe-menu", revision: 2 },
        { name: "cafe-menu-bbbbbbbb", revision: 2 },
      ],
    });
  });

  it("keeps same-title explicit takeovers distinct from later generated pins", () => {
    const store = createStore();
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "release-status",
      title: "Release Status",
      content: { kind: "html", html: "<p>generated</p>" },
      generatedIdentity: generatedIdentity("c", "release-status-cccccccc"),
    });
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "release-status",
      title: "Release Status",
      content: { kind: "html", html: "<p>manual</p>" },
    });
    const generatedAfterTakeover = store.putWidget({
      sessionKey: "agent:main:board",
      name: "release-status",
      title: "Release Status",
      content: { kind: "html", html: "<p>generated</p>" },
      generatedIdentity: generatedIdentity("c", "release-status-cccccccc"),
    });
    expect(generatedAfterTakeover.resolvedWidgetName).toBe("release-status-cccccccc");
    expect(generatedAfterTakeover.widgets).toHaveLength(2);
    expect(store.readWidgetHtml("agent:main:board", "release-status")?.html).toContain("manual");
  });

  it("fails closed instead of overwriting an occupied deterministic fallback", () => {
    const store = createStore();
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "status",
      title: "Manual",
      content: { kind: "html", html: "manual" },
    });
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "status-dddddddd",
      title: "Reserved",
      content: { kind: "html", html: "reserved" },
    });

    expect(() =>
      store.putWidget({
        sessionKey: "agent:main:board",
        name: "status",
        title: "Generated",
        content: { kind: "html", html: "generated" },
        generatedIdentity: generatedIdentity("d", "status-dddddddd"),
      }),
    ).toThrow("generated widget fallback name is already in use");
    expect(store.getSnapshot("agent:main:board").widgets).toHaveLength(2);
  });

  it("rejects a fallback that is not distinct even on an empty board", () => {
    const store = createStore();
    expect(() =>
      store.putWidget({
        sessionKey: "agent:main:board",
        name: "status",
        title: "Status",
        content: { kind: "html", html: "generated" },
        generatedIdentity: generatedIdentity("f", "status"),
      }),
    ).toThrow("generated widget fallback name must differ from its preferred name");
  });
});

it("preserves a beta.5-format unmarked explicit row and reuses the generated fallback", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-beta5-identity-") };
  const sessionKey = "agent:main:beta5-identity";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  const store = new SqliteBoardStore(options);
  store.putWidget({
    sessionKey,
    name: "anchor",
    title: "Anchor",
    content: { kind: "html", html: "<p>anchor</p>" },
  });
  const legacy = store.putWidget({
    sessionKey,
    name: "cafe-menu",
    title: "Café Menu",
    content: { kind: "html", html: "<p>approved</p>" },
    declared: { tools: ["menu.refresh"] },
  });
  store.grant(
    sessionKey,
    "cafe-menu",
    "granted",
    1,
    legacy.widgets.find((widget) => widget.name === "cafe-menu")?.instanceId,
  );
  store.applyOps(sessionKey, [{ kind: "widget_resize", name: "cafe-menu", sizeW: 8, sizeH: 6 }]);
  const seededDatabase = openOpenClawAgentDatabase({ agentId: "main", env });
  seededDatabase.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
    )
    .run(sessionKey, "cafe-menu");

  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const reopened = new SqliteBoardStore(options);
  const generated = reopened.putWidget({
    sessionKey,
    name: "cafe-menu",
    title: "Cafe\u0301 Menu",
    content: { kind: "html", html: "<p>generated</p>" },
    generatedIdentity: generatedIdentity("e", "cafe-menu-eeeeeeee"),
  });
  expect(generated.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(generated.widgets.find((widget) => widget.name === "cafe-menu")).toMatchObject({
    name: "cafe-menu",
    revision: 1,
    grantState: "granted",
    sizeW: 8,
    sizeH: 6,
    position: 1,
  });
  expect(reopened.readWidgetHtml(sessionKey, "cafe-menu")?.html).toContain("approved");

  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const durable = new SqliteBoardStore(options);
  const reused = durable.putWidget({
    sessionKey,
    name: "cafe-menu",
    title: "Café Menu",
    content: { kind: "html", html: "<p>generated revised</p>" },
    generatedIdentity: generatedIdentity("e", "cafe-menu-eeeeeeee"),
  });
  expect(reused.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(reused.widgets.find((widget) => widget.name === "cafe-menu-eeeeeeee")).toMatchObject({
    revision: 2,
  });
  expect(durable.readWidgetHtml(sessionKey, "cafe-menu")?.html).toContain("approved");
  closeOpenClawAgentDatabasesForTest();

  expect(
    new SqliteBoardStore(options)
      .getSnapshot(sessionKey)
      .widgets.find((widget) => widget.name === "cafe-menu"),
  ).toMatchObject({
    name: "cafe-menu",
    revision: 1,
    grantState: "granted",
    sizeW: 8,
    sizeH: 6,
    position: 1,
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const row = database.db
    .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = ?")
    .get(sessionKey, "cafe-menu-eeeeeeee") as { manifest: string };
  expect(JSON.parse(row.manifest)).toMatchObject({
    nameIdentity: { kind: "generated", source: "show_widget", key: "e".repeat(64) },
  });
});

it("does not infer generated ownership from a canonical unmarked title match", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-canonical-legacy-") };
  const sessionKey = "agent:main:canonical-legacy";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  const store = new SqliteBoardStore(options);
  store.putWidget({
    sessionKey,
    name: "widget-e3b21956",
    title: "が",
    content: { kind: "html", html: "<p>legacy</p>" },
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
    )
    .run(sessionKey, "widget-e3b21956");
  closeOpenClawAgentDatabasesForTest();

  const reopened = new SqliteBoardStore(options);
  const generated = reopened.putWidget({
    sessionKey,
    name: "widget-f62b28f7",
    title: "が",
    content: { kind: "html", html: "<p>updated</p>" },
    generatedIdentity: generatedIdentity("a", "widget-aaaaaaaa"),
  });
  expect(generated.resolvedWidgetName).toBe("widget-f62b28f7");
  expect(generated.widgets).toHaveLength(2);
  expect(reopened.readWidgetHtml(sessionKey, "widget-e3b21956")?.html).toContain("legacy");
});

it("preserves unmarked rows whose absent or capped titles are ambiguous", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-ambiguous-legacy-") };
  const sessionKey = "agent:main:ambiguous-legacy";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  const store = new SqliteBoardStore(options);
  const cappedTitle = `${"!".repeat(79)}a`;
  store.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "<p>manual untitled</p>" },
  });
  store.putWidget({
    sessionKey,
    name: "report",
    title: cappedTitle,
    content: { kind: "html", html: "<p>legacy long</p>" },
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ?",
    )
    .run(sessionKey);
  closeOpenClawAgentDatabasesForTest();

  const reopened = new SqliteBoardStore(options);
  const untitled = reopened.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "<p>generated untitled</p>" },
    generatedIdentity: generatedIdentity("b", "status-bbbbbbbb"),
  });
  const long = reopened.putWidget({
    sessionKey,
    name: "report",
    title: cappedTitle,
    content: { kind: "html", html: "<p>generated long</p>" },
    generatedIdentity: generatedIdentity("c", "report-cccccccc"),
  });

  expect(untitled.resolvedWidgetName).toBe("status-bbbbbbbb");
  expect(long.resolvedWidgetName).toBe("report-cccccccc");
  expect(reopened.readWidgetHtml(sessionKey, "status")?.html).toContain("manual untitled");
  expect(reopened.readWidgetHtml(sessionKey, "report")?.html).toContain("legacy long");
});

it("persists explicit ownership across restart", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-explicit-owner-") };
  const sessionKey = "agent:main:explicit-owner";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  new SqliteBoardStore(options).putWidget({
    sessionKey,
    name: "status",
    title: "Status",
    content: { kind: "html", html: "<p>manual</p>" },
  });
  closeOpenClawAgentDatabasesForTest();

  const reopened = new SqliteBoardStore(options);
  const generated = reopened.putWidget({
    sessionKey,
    name: "status",
    title: "Status",
    content: { kind: "html", html: "<p>generated</p>" },
    generatedIdentity: generatedIdentity("d", "status-dddddddd"),
  });
  expect(generated.resolvedWidgetName).toBe("status-dddddddd");
  expect(reopened.readWidgetHtml(sessionKey, "status")?.html).toContain("manual");
});
