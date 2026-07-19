import { describe, expect, it } from "vitest";
import { BoardValidationError } from "./board-layout.js";
import { InMemoryBoardStore } from "./board-store.js";

function putHtml(store: InMemoryBoardStore, sessionKey: string, name: string, html = "<p>one</p>") {
  return store.putWidget({ sessionKey, name, content: { kind: "html", html } });
}

describe("in-memory board store", () => {
  it("creates the implicit main tab and bumps board and widget revisions", () => {
    const store = new InMemoryBoardStore();
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

  it("returns immutable snapshots and lists only existing boards", () => {
    const store = new InMemoryBoardStore();
    putHtml(store, "session-b", "b");
    putHtml(store, "session-a", "a");
    const snapshot = store.getSnapshot("session-a");
    snapshot.tabs[0]!.title = "Changed";
    expect(store.getSnapshot("session-a").tabs[0]!.title).toBe("Main");
    expect(store.listSessionsWithBoards()).toEqual(["session-a", "session-b"]);
    expect(store.getSnapshot("missing")).toEqual({
      sessionKey: "missing",
      revision: 0,
      tabs: [],
      widgets: [],
    });
  });

  it("stores HTML bytes with digest and keeps MCP descriptors non-HTML", () => {
    const store = new InMemoryBoardStore();
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
          originSessionKey: "origin",
          toolCallId: "call",
        },
      },
    });
    expect(store.readWidgetHtml("session", "html")).toMatchObject({
      html: "<main>ok</main>",
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.readWidgetHtml("session", "app")).toEqual({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        originSessionKey: "origin",
        toolCallId: "call",
      },
      revision: 1,
    });
    expect(store.readWidgetHtml("session", "unknown")).toBeUndefined();
  });

  it("transitions declared widgets through pending grants", () => {
    const store = new InMemoryBoardStore();
    const pending = store.putWidget({
      sessionKey: "session",
      name: "networked",
      content: { kind: "html", html: "<p>ok</p>" },
      declared: { netOrigins: ["https://example.com"] },
    });
    expect(pending.widgets[0]!.grantState).toBe("pending");
    expect(store.grant("session", "networked", "granted", 1).widgets[0]!.grantState).toBe(
      "granted",
    );
    expect(() => store.grant("session", "networked", "rejected", 1)).toThrow("not pending");
  });

  it("survives reset/new boundaries", () => {
    const store = new InMemoryBoardStore();
    putHtml(store, "session", "status");
    // Session reset has no BoardStore call; the stable session key remains authoritative.
    expect(store.getSnapshot("session").widgets).toHaveLength(1);
  });

  it("rejects stale grant revisions and accepts the current revision", () => {
    const store = new InMemoryBoardStore();
    store.putWidget({
      sessionKey: "session",
      name: "networked",
      content: { kind: "html", html: "ok" },
      declared: { tools: ["weather.refresh"] },
    });
    try {
      store.grant("session", "networked", "granted", 2);
      throw new Error("expected stale grant to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoardValidationError);
      expect(error).toMatchObject({ code: "conflict" });
      expect((error as Error).message).toContain("revision changed");
    }
    expect(store.grant("session", "networked", "granted", 1).widgets[0]).toMatchObject({
      grantState: "granted",
      revision: 1,
    });
  });

  it("enforces the board widget count and UTF-8 HTML byte limits", () => {
    const store = new InMemoryBoardStore();
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
    expect(() =>
      putHtml(new InMemoryBoardStore(), "session", "large", "é".repeat(131_073)),
    ).toThrow("262144 UTF-8 bytes");
  });

  it("bumps once per applyOps transaction and removes widget bytes", () => {
    const store = new InMemoryBoardStore();
    putHtml(store, "session", "status");
    const snapshot = store.applyOps("session", [
      { kind: "widget_resize", name: "status", sizeW: 3, sizeH: 3 },
      { kind: "widget_remove", name: "status" },
    ]);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.widgets).toEqual([]);
    expect(store.readWidgetHtml("session", "status")).toBeUndefined();
  });

  it("preserves position on content updates and honors explicit after placement", () => {
    const store = new InMemoryBoardStore();
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
