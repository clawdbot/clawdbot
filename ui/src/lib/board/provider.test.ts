// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boardExists,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
} from "./provider.ts";

type MockProvider = BoardProvider & { emitCommand(command: BoardCommandEvent["command"]): void };

let mockLocation: { search: string };

function mockBoardProvider(sessionKey: string): MockProvider {
  return boardProviderForSession(sessionKey) as MockProvider;
}

beforeEach(() => {
  mockLocation = { search: "?mockBoard=1" };
  vi.stubGlobal("location", mockLocation);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("board providers", () => {
  it("keeps the null provider chat-only", () => {
    mockLocation.search = "";
    const provider = boardProviderForSession("agent:main:plain");

    expect(boardExists(provider.snapshot$.value)).toBe(false);
    expect(provider.snapshot$.value).toEqual({
      sessionKey: "agent:main:plain",
      revision: 0,
      tabs: [],
      widgets: [],
    });
  });

  it("provides two mock tabs with mixed widget sizes", () => {
    const snapshot = mockBoardProvider("agent:main:main").snapshot$.value;

    expect(snapshot.tabs).toHaveLength(2);
    expect(snapshot.tabs.map((tab) => tab.chatDock)).toEqual(["right", "bottom"]);
    expect(new Set(snapshot.widgets.map((widget) => `${widget.sizeW}x${widget.sizeH}`)).size).toBe(
      3,
    );
  });

  it("applies dock operations and publishes snapshots", async () => {
    const provider = mockBoardProvider("agent:main:main");
    const changed = vi.fn();
    provider.snapshot$.subscribe(changed);

    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);

    expect(provider.snapshot$.value.tabs[0]?.chatDock).toBe("left");
    expect(provider.snapshot$.value.revision).toBe(2);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("preserves tabs when a reorder is not a complete permutation", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([{ kind: "tabs_reorder", tabIds: ["research"] }]);

    expect(provider.snapshot$.value.tabs.map((tab) => tab.tabId)).toEqual(["main", "research"]);
  });

  it("does not create or reorder duplicate tab ids", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "tab_create", tabId: "main", title: "Duplicate" },
      { kind: "tabs_reorder", tabIds: ["main", "research", "main"] },
    ]);

    expect(provider.snapshot$.value.tabs.map((tab) => tab.tabId)).toEqual(["main", "research"]);
  });

  it("reorders widgets after a named anchor", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "widget_move", name: "session-status", after: "recent-findings" },
    ]);

    expect(
      provider.snapshot$.value.widgets
        .filter((widget) => widget.tabId === "main")
        .toSorted((left, right) => left.position - right.position)
        .map((widget) => widget.name),
    ).toEqual(["recent-findings", "session-status"]);
  });

  it("moves widgets across tabs and normalizes both tab orders", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "widget_move", name: "source-map", tabId: "main", after: "session-status" },
    ]);

    expect(
      provider.snapshot$.value.widgets
        .filter((widget) => widget.tabId === "main")
        .map((widget) => `${widget.position}:${widget.name}`),
    ).toEqual(["0:session-status", "1:source-map", "2:recent-findings"]);
    expect(
      provider.snapshot$.value.widgets.filter((widget) => widget.tabId === "research"),
    ).toEqual([]);
  });

  it("clamps widget sizes to the board grid", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "widget_resize", name: "session-status", sizeW: 99, sizeH: -5 },
    ]);

    expect(provider.snapshot$.value.widgets[0]).toMatchObject({ sizeW: 12, sizeH: 1 });
  });

  it("surfaces agent board commands", () => {
    const provider = mockBoardProvider("agent:main:main");
    const listener = vi.fn();
    provider.events.subscribe(listener);

    provider.emitCommand({ kind: "set_chat_dock", dock: "hidden" });
    provider.emitCommand({ kind: "focus_tab", tabId: "research" });

    expect(listener).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:main:main",
      command: { kind: "set_chat_dock", dock: "hidden" },
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      sessionKey: "agent:main:main",
      command: { kind: "focus_tab", tabId: "research" },
    });
  });

  it("shares one provider across equivalent main session keys", () => {
    vi.stubGlobal("location", { search: "?mockBoard=1" });

    expect(boardProviderForSession("main")).toBe(boardProviderForSession("agent:main:main"));
  });

  it("provides mock boards for canonical configured-main session keys", () => {
    vi.stubGlobal("location", { search: "?mockBoard=1" });

    expect(boardExists(boardProviderForSession("agent:work:primary").snapshot$.value)).toBe(true);
  });
});
