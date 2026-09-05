import { beforeEach, describe, expect, it } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { selectAgentSystemEvents } from "../../infra/system-event-ownership.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createBoardHarness as createHarness } from "./board.test-support.js";

describe("board gateway notices", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
    return () => resetPluginRuntimeStateForTest();
  });

  it("appends bounded dashboard notices and coalesces duplicate bursts", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const first = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: { count: 1 },
    });
    const duplicate = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: { count: 1 },
    });
    expect(first.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
    expect(duplicate.mock.calls[0]?.[1]).toEqual({ ok: true, appended: false });
    expect(peekSystemEvents("agent:main:session")).toEqual([
      '[dashboard] {"count":1} on widget counter',
    ]);
  });

  it("keeps identical global widget notices separate for each owner", async () => {
    const { invoke } = createHarness(undefined, {}, undefined, {
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        session: { scope: "global" },
      }),
    });
    for (const agentId of ["main", "work"]) {
      const target = { sessionKey: "global", agentId };
      await invoke("board.widget.put", {
        ...target,
        name: "counter",
        content: { kind: "html", html: "ok" },
      });
      const board = await invoke("board.get", target);
      const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
      const ticket = snapshot.widgets[0]?.viewTicket;
      const first = await invoke("board.event", { ticket, payload: { count: 1 } });
      const duplicate = await invoke("board.event", {
        ...target,
        widget: "counter",
        payload: { count: 1 },
      });
      expect(first.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
      expect(duplicate.mock.calls[0]?.[1]).toEqual({ ok: true, appended: false });
    }
    const events = peekSystemEventEntries("global");
    expect(events).toHaveLength(2);
    for (const agentId of ["main", "work"]) {
      expect(selectAgentSystemEvents(events, agentId).map((event) => event.text)).toEqual([
        '[dashboard] {"count":1} on widget counter',
      ]);
    }
  });

  it("binds state.emit notices to the widget view ticket", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const ticket = snapshot.widgets[0]?.viewTicket;

    const response = await invoke("board.event", { ticket, payload: { count: 2 } });

    expect(response.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
    expect(peekSystemEvents("agent:main:session")).toEqual([
      '[dashboard] {"count":2} on widget counter',
    ]);
  });
});
