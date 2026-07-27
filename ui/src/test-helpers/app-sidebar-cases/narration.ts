import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

const defaults: SessionsListResult["defaults"] = {
  modelProvider: null,
  model: null,
  contextTokens: null,
};

function runningRow(key: string, updatedAt: number): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    label: `Run ${updatedAt}`,
    updatedAt,
    startedAt: updatedAt,
    status: "running",
    hasActiveRun: true,
  };
}

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 10,
    path: "",
    count: rows.length,
    defaults,
    sessions: rows,
  };
}

describe("AppSidebar live narration", () => {
  it("subscribes for a running row, renders prose, and cleans up when the run ends", async () => {
    const key = "agent:main:narrated";
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", [key]);
    sessions.publishList({ result: sessionsResult([runningRow(key, 5)]), agentId: "main" });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));
    expect(sessions.subscribeMessages).toHaveBeenCalledWith(key, { agentId: undefined });

    gateway.publishEvent("chat", {
      sessionKey: key,
      state: "delta",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "# Earlier work\n\nChecked the inputs. Final **verification** is running.",
          },
        ],
      },
    });

    await waitForFast(() =>
      expect(
        sidebar.querySelector(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`)
          ?.textContent,
      ).toBe("Final verification is running."),
    );
    const link = sidebar.querySelector<HTMLAnchorElement>(
      `[data-session-key="${key}"] .sidebar-recent-session__link`,
    );
    expect(link?.title).toContain("Final verification is running.");
    expect(link?.querySelector("[aria-live]")).toBeNull();

    sessions.publishList({
      result: sessionsResult([
        { ...runningRow(key, 5), hasActiveRun: false, status: "done", endedAt: 20 },
      ]),
      agentId: "main",
    });
    await waitForFast(() => expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1));
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`),
    ).toBeNull();
  });

  it("gives a pending question attention priority over a running narration", async () => {
    const key = "agent:main:needs-answer";
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", [key]);
    sessions.publishList({ result: sessionsResult([runningRow(key, 5)]), agentId: "main" });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;

    // Republish inside the wait: the narration controller chunk loads lazily,
    // so an event raced before its import resolves is intentionally dropped.
    await waitForFast(() => {
      gateway.publishEvent("chat", {
        sessionKey: key,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Checking the remaining files." }],
        },
      });
      expect(
        sidebar.querySelector(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`)
          ?.textContent,
      ).toBe("Checking the remaining files.");
    });

    gateway.publishEvent("question.requested", {
      id: "question-narration-priority",
      agentId: "main",
      sessionKey: key,
      questions: [{ questionId: "confirm", header: "Confirm", question: "Continue?", options: [] }],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    });
    await sidebar.updateComplete;

    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    expect(row?.querySelector("[data-session-attention=question]")).not.toBeNull();
    expect(row?.querySelector(".sidebar-recent-session__subtitle")?.textContent).toBe(
      "Waiting for your answer",
    );
    expect(row?.textContent).not.toContain("Checking the remaining files.");
    expect(
      row?.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link")?.title,
    ).not.toContain("Checking the remaining files.");
  });

  it("keeps only the six newest running subscriptions and evicts the old boundary", async () => {
    const keys = Array.from({ length: 7 }, (_, index) => `agent:main:run-${index + 1}`);
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", keys);
    const rows = keys.map((key, index) => runningRow(key, index + 1));
    sessions.publishList({ result: sessionsResult(rows), agentId: "main" });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(6));
    expect(sessions.subscribeMessages.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining(keys.slice(1)),
    );
    expect(sessions.subscribeMessages).not.toHaveBeenCalledWith(keys[0], expect.anything());

    sessions.publishList({
      result: sessionsResult([{ ...rows[0]!, startedAt: 100 }, ...rows.slice(1)]),
      agentId: "main",
    });
    await waitForFast(() => expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1));
    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(7));
    expect(sessions.unsubscribeMessages.mock.calls[0]?.[0]).toMatchObject({ key: keys[1] });
    expect(sessions.subscribeMessages.mock.calls.at(-1)?.[0]).toBe(keys[0]);
  });

  it("stays inert when the synced preference is off", async () => {
    const key = "agent:main:quiet";
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", [key]);
    sessions.publishList({ result: sessionsResult([runningRow(key, 1)]), agentId: "main" });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.sidebarLiveActivity = false;
    sidebar.connected = true;
    await sidebar.updateComplete;

    gateway.publishEvent("chat", {
      sessionKey: key,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Should stay hidden" }] },
    });
    await sidebar.updateComplete;

    expect(sessions.subscribeMessages).not.toHaveBeenCalled();
    expect(
      sidebar.querySelector(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`),
    ).toBeNull();
  });

  it("skips the open chat subscription and resubscribes background runs after reconnect", async () => {
    const openKey = "agent:main:open";
    const backgroundKey = "agent:main:background";
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", [openKey, backgroundKey]);
    sessions.publishList({
      result: sessionsResult([runningRow(openKey, 1), runningRow(backgroundKey, 2)]),
      agentId: "main",
    });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = openKey;
    sidebar.connected = true;
    await sidebar.updateComplete;

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));
    expect(sessions.subscribeMessages).toHaveBeenLastCalledWith(backgroundKey, {
      agentId: undefined,
    });

    gateway.publish({ phase: "stopped" });
    sidebar.connected = false;
    await sidebar.updateComplete;
    await waitForFast(() => expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1));

    gateway.publish({ phase: "connected" });
    sidebar.connected = true;
    await sidebar.updateComplete;
    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(2));
    expect(sessions.subscribeMessages).toHaveBeenLastCalledWith(backgroundKey, {
      agentId: undefined,
    });
  });
});
