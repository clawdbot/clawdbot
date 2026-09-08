import { afterEach, describe, expect, it } from "vitest";
import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { BoardValidationError } from "./board-layout.js";
import { createBoardWidgetPutSnapshot, type BoardStore } from "./board-store.js";
import { createTestBoardStore } from "./board-store.test-support.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function putHtml(store: BoardStore, sessionKey: string, name: string, html = "<p>one</p>") {
  return store.putWidget({ sessionKey, name, content: { kind: "html", html } });
}

const widgetContents = [
  { kind: "html", html: "<p>original</p>" },
  { kind: "plugin", pluginKind: "workboard:card", props: { cardId: "original" } },
  {
    kind: "registered",
    contentKind: "diagram",
    pluginKind: "diagram:diagram",
    source: "diagram:original",
  },
  {
    kind: "mcp-app",
    descriptor: {
      serverName: "server",
      toolName: "tool",
      uiResourceUri: "ui://resource",
      toolCallId: "call",
    },
    interactive: false,
  },
] satisfies BoardWidgetMaterializedPutParams["content"][];

describe("board store", () => {
  it("creates the implicit main tab and bumps board and widget revisions", () => {
    const store = createTestBoardStore();
    const first = putHtml(store, "agent:main:main", "status");
    const second = putHtml(store, "agent:main:main", "status", "<p>two</p>");
    expect(first).toMatchObject({
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0 }],
      widgets: [{ name: "status", revision: 1 }],
    });
    expect(second.revision).toBe(2);
    expect(second.widgets[0]!.revision).toBe(2);
  });

  it.each(widgetContents)(
    "preserves $kind widget ownership across same-name updates",
    (content) => {
      const store = createTestBoardStore();
      const name = `${content.kind}-status`;
      const created = store.putWidget({ sessionKey: "session", name, content });

      expect(created.widgets[0]).toMatchObject({
        contentOwner: content.kind,
        ...(content.kind === "registered" ? { registeredContentKind: content.contentKind } : {}),
      });

      for (const replacement of widgetContents.filter(
        (candidate) => candidate.kind !== content.kind,
      )) {
        expect(() =>
          store.putWidget({ sessionKey: "session", name, content: replacement }),
        ).toThrow(
          expect.objectContaining({
            code: "invalid_operation",
            message: expect.stringMatching(/same content kind.*remove/i),
          }),
        );
        expect(store.getSnapshot({ sessionKey: "session" })).toMatchObject({
          revision: created.revision,
          widgets: created.widgets,
        });
      }

      if (content.kind === "plugin" || content.kind === "registered") {
        expect(() =>
          store.putWidget({
            sessionKey: "session",
            name,
            content: { ...content, pluginKind: "other:replacement" },
          }),
        ).toThrow(expect.objectContaining({ code: "invalid_operation" }));
        expect(store.getSnapshot({ sessionKey: "session" })).toMatchObject({
          revision: created.revision,
          widgets: created.widgets,
        });
      }

      if (content.kind === "registered") {
        expect(() =>
          store.putWidget({
            sessionKey: "session",
            name,
            content: { ...content, contentKind: "alternate" },
          }),
        ).toThrow(expect.objectContaining({ code: "invalid_operation" }));
        expect(store.getSnapshot({ sessionKey: "session" })).toMatchObject({
          revision: created.revision,
          widgets: created.widgets,
        });
      }

      if (content.kind === "plugin") {
        const withIncidentalInstance = {
          ...created,
          widgets: created.widgets.map((widget) => ({ ...widget, instanceId: "incidental" })),
        };
        expect(
          createBoardWidgetPutSnapshot(
            withIncidentalInstance,
            { sessionKey: created.sessionKey, name, content },
            { grantScopeMatches: true, instanceId: "replacement" },
          ).widgets[0],
        ).toMatchObject({ contentOwner: "plugin", revision: 2 });
      }

      expect(store.putWidget({ sessionKey: "session", name, content }).widgets[0]).toMatchObject({
        name,
        revision: 2,
      });

      store.applyOps({ sessionKey: "session" }, [{ kind: "widget_remove", name }]);
      const replacement = widgetContents.find((candidate) => candidate.kind !== content.kind)!;
      expect(
        store.putWidget({ sessionKey: "session", name, content: replacement }).widgets[0],
      ).toMatchObject({
        contentKind: replacement.kind === "registered" ? "plugin" : replacement.kind,
        contentOwner: replacement.kind,
        revision: 1,
      });
    },
  );

  it("upgrades registered ownership from its exact legacy descriptor and preserves it", () => {
    const stateDir = tempDirs.make("openclaw-board-legacy-registered-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:legacy-registered";
    const store = createTestBoardStore({ stateDir });
    const content = {
      kind: "registered" as const,
      contentKind: "diagram",
      pluginKind: "diagram:diagram",
      source: "diagram:first",
    };
    store.putWidget({ sessionKey, name: "status", content, declared: { tools: ["health"] } });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = json_set(manifest, '$.registeredContentKind', 'other') WHERE session_key = ? AND name = 'status'",
      )
      .run(sessionKey);
    expect(() => store.getSnapshot({ sessionKey })).toThrow(/content ownership/i);
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = json_remove(manifest, '$.contentOwner', '$.registeredContentKind', '$.registeredInstanceId') WHERE session_key = ? AND name = 'status'",
      )
      .run(sessionKey);

    const legacy = store.getSnapshot({ sessionKey }).widgets[0]!;
    expect(legacy).toMatchObject({ contentOwner: "registered", registeredContentKind: "diagram" });
    expect(legacy).not.toHaveProperty("instanceId");
    expect(() =>
      store.putWidget({
        sessionKey,
        name: "status",
        content: { kind: "plugin", pluginKind: "diagram:diagram" },
      }),
    ).toThrow(/same content kind.*remove/i);
    expect(() =>
      store.putWidget({
        sessionKey,
        name: "status",
        content: { ...content, contentKind: "other" },
      }),
    ).toThrow(/same content kind.*remove/i);

    const refreshed = store.putWidget({
      sessionKey,
      name: "status",
      content: { ...content, source: "diagram:refreshed" },
      declared: { tools: ["health"] },
    });
    store.grant({ sessionKey }, "status", "granted", 2, refreshed.widgets[0]?.instanceId);
    const row = database.db
      .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
      .get(sessionKey) as { manifest: string };
    expect(JSON.parse(row.manifest)).toMatchObject({
      contentOwner: "registered",
      registeredContentKind: "diagram",
      grantSemanticsVersion: 2,
    });
  });

  it("returns immutable snapshots and isolates session boards", () => {
    const store = createTestBoardStore();
    putHtml(store, "session-b", "b");
    putHtml(store, "session-a", "a");
    const snapshot = store.getSnapshot({ sessionKey: "session-a" });
    snapshot.tabs[0]!.title = "Changed";
    expect(store.getSnapshot({ sessionKey: "session-a" }).tabs[0]!.title).toBe("Main");
    expect(store.getSnapshot({ sessionKey: "session-a" }).widgets).toMatchObject([{ name: "a" }]);
    expect(store.getSnapshot({ sessionKey: "session-b" }).widgets).toMatchObject([{ name: "b" }]);
    expect(store.getSnapshot({ sessionKey: "missing" })).toEqual({
      sessionKey: "agent:main:missing",
      revision: 0,
      tabs: [],
      widgets: [],
    });
  });

  it("stores HTML bytes with digest and keeps MCP descriptors non-HTML", () => {
    const store = createTestBoardStore();
    putHtml(store, "session", "html", "<main>ok</main>");
    store.putWidget({
      sessionKey: "session",
      name: "app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          toolCallId: "call",
        },
        interactive: false,
      },
    });
    expect(store.readWidgetHtml({ sessionKey: "session" }, "html")).toMatchObject({
      html: "<main>ok</main>",
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.readWidgetHtml({ sessionKey: "session" }, "app")).toBeUndefined();
    expect(store.readWidgetMcpApp({ sessionKey: "session" }, "app")).toMatchObject({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      revision: 1,
      instanceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      interactive: false,
    });
    expect(store.readWidgetHtml({ sessionKey: "session" }, "unknown")).toBeUndefined();
  });

  it("transitions declared widgets through pending grants", () => {
    const store = createTestBoardStore();
    const pending = store.putWidget({
      sessionKey: "session",
      name: "networked",
      content: { kind: "html", html: "<p>ok</p>" },
      declared: { netOrigins: ["https://example.com"] },
    });
    expect(pending.widgets[0]!.grantState).toBe("pending");
    expect(
      store.grant(
        { sessionKey: "session" },
        "networked",
        "granted",
        1,
        pending.widgets[0]?.instanceId,
      ).widgets[0]!.grantState,
    ).toBe("granted");
    expect(() =>
      store.grant(
        { sessionKey: "session" },
        "networked",
        "rejected",
        1,
        pending.widgets[0]?.instanceId,
      ),
    ).toThrow("not pending");
  });

  it("survives reset/new boundaries", () => {
    const store = createTestBoardStore();
    putHtml(store, "session", "status");
    // Session reset has no BoardStore call; the stable session key remains authoritative.
    expect(store.getSnapshot({ sessionKey: "session" }).widgets).toHaveLength(1);
  });

  it("rejects stale grant revisions and accepts the current revision", () => {
    const store = createTestBoardStore();
    const pending = store.putWidget({
      sessionKey: "session",
      name: "networked",
      content: { kind: "html", html: "ok" },
      declared: { tools: ["weather.refresh"] },
    });
    try {
      store.grant({ sessionKey: "session" }, "networked", "granted", 2);
      throw new Error("expected stale grant to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoardValidationError);
      expect(error).toMatchObject({ code: "conflict" });
      expect((error as Error).message).toContain("revision changed");
    }
    expect(
      store.grant(
        { sessionKey: "session" },
        "networked",
        "granted",
        1,
        pending.widgets[0]?.instanceId,
      ).widgets[0],
    ).toMatchObject({
      grantState: "granted",
      revision: 1,
    });
  });

  it("enforces the board widget count and UTF-8 HTML byte limits", () => {
    const store = createTestBoardStore();
    for (let index = 0; index < 48; index += 1) {
      putHtml(store, "session", `widget-${index}`, "ok");
    }
    try {
      putHtml(store, "session", "widget-48", "ok");
      throw new Error("expected widget cap to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoardValidationError);
      expect(error).toMatchObject({ code: "invalid_operation" });
      expect((error as Error).message).toContain("more than 48 widgets");
    }
    expect(() => putHtml(createTestBoardStore(), "session", "large", "é".repeat(131_073))).toThrow(
      "262144 UTF-8 bytes",
    );
  });

  it("bumps once per applyOps transaction and removes widget bytes", () => {
    const store = createTestBoardStore();
    putHtml(store, "session", "status");
    const snapshot = store.applyOps({ sessionKey: "session" }, [
      { kind: "widget_resize", name: "status", sizeW: 3, sizeH: 3 },
      { kind: "widget_remove", name: "status" },
    ]);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.widgets).toEqual([]);
    expect(store.readWidgetHtml({ sessionKey: "session" }, "status")).toBeUndefined();
  });

  it("preserves position on content updates and honors explicit after placement", () => {
    const store = createTestBoardStore();
    putHtml(store, "session", "first");
    putHtml(store, "session", "second");
    putHtml(store, "session", "third");

    expect(
      putHtml(store, "session", "first", "<p>updated</p>").widgets.map((widget) => widget.name),
    ).toEqual(["first", "second", "third"]);
    expect(
      store
        .putWidget({
          sessionKey: "session",
          name: "first",
          content: { kind: "html", html: "<p>moved</p>" },
          placement: { after: "third" },
        })
        .widgets.map((widget) => widget.name),
    ).toEqual(["second", "third", "first"]);
  });
});
