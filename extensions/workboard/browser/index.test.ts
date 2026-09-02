import "./test/dom.setup.ts";
import type { ControlUiAccessory, ControlUiAction } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import workboardPlugin from "./index.ts";
import { createGatewaySession, createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

it("opens an existing reassigned session card after fresh activation without visiting Workboard", async () => {
  const { host, connection, registrations } = workboardTestHost();
  connection.connected = true;
  const session = createGatewaySession({ key: "agent:writer:dashboard:captured" });
  const card = createWorkboardCard({
    title: "Previously captured conversation",
    sessionKey: session.key,
    agentId: "main",
    metadata: { automation: { boardId: "ops" } },
  });
  Object.assign(host.sessions, { rows: [session], selectedKey: session.key });
  Object.assign(host.agents, {
    rows: [{ id: "main" }, { id: "writer" }],
    selectedId: "writer",
    scopeId: "writer",
  });
  const boards = [{ id: "ops", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }];
  let currentCard = card;
  const request = vi.fn(async (method: string) => {
    if (method === "workboard.cards.list") {
      return { cards: [currentCard], boards };
    }
    if (method === "workboard.boards.list") {
      return { boards };
    }
    return { tasks: [] };
  });
  host.request = request as typeof host.request;
  const dispose = await workboardPlugin.activate(host);
  const container = document.createElement("div");
  let disposeAccessory = () => {};
  try {
    await vi.waitFor(() => expect(registrations.has("navigation/board-ops")).toBe(true));
    const context = { sessionKey: session.key, session };
    for (const id of ["capture-current-session", "capture-session"]) {
      const action = registrations.get(`action/${id}`) as ControlUiAction;
      expect.soft(action.resolve?.(context)?.label).toBe("Open Workboard card");
    }

    const accessory = registrations.get("accessory/linked-card") as ControlUiAccessory;
    const mounted = accessory.mount(container, createViewContext(host, context));
    disposeAccessory = () => mounted?.dispose?.();
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    expect(request.mock.calls).toEqual([["workboard.cards.list", {}]]);

    // Activation shares a catalog; an action still needs current card and task state.
    currentCard = {
      ...card,
      title: "Current captured conversation",
      updatedAt: card.updatedAt + 1,
    };
    request.mockClear();
    const action = registrations.get("action/capture-current-session") as ControlUiAction;
    await action.run({ ...context, host, signal: host.signal });

    expect(request.mock.calls).toEqual([
      ["workboard.cards.list", {}],
      ["tasks.list", { limit: 500 }],
    ]);
    expect(container.textContent).toContain(currentCard.title);
    expect(host.navigation.openPage).toHaveBeenCalledWith({ id: "workboard", path: ["ops"] });
    expect(host.agents.scopeId).toBeNull();
    expect(host.agents.selectedId).toBe("writer");
    expect(
      request.mock.calls.filter(([method]) => method === "workboard.cards.captureSession"),
    ).toHaveLength(0);
  } finally {
    disposeAccessory();
    dispose?.();
  }
});

it("keeps actions and accessories on the same recovered snapshot and retires pending activation reads", async () => {
  const fixture = workboardTestHost();
  const { host, connection, registrations } = fixture;
  connection.connected = true;
  const session = createGatewaySession();
  const card = createWorkboardCard({ title: "Linked card", sessionKey: session.key });
  const boards = [{ id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }];
  const request = vi.fn().mockResolvedValue({ cards: [card], boards });
  host.request = request as typeof host.request;
  const dispose = await workboardPlugin.activate(host);
  const container = document.createElement("div");
  const context = { sessionKey: session.key, session };
  const action = registrations.get("action/capture-current-session") as ControlUiAction;
  const accessory = registrations.get("accessory/linked-card") as ControlUiAccessory;
  const mounted = accessory.mount(container, createViewContext(host, context));
  let disposed = false;
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    expect(action.resolve?.(context)?.label).toBe("Open Workboard card");

    request.mockRejectedValueOnce(new Error("Temporary read failure"));
    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(request.mock.settledResults[1]?.type).toBe("rejected"));
    expect(container.textContent).toContain(card.title);
    expect(action.resolve?.(context)?.label).toBe("Open Workboard card");

    request.mockResolvedValueOnce({ cards: [{ ...card, metadata: { archivedAt: 1 } }], boards });
    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(container.querySelector("a")).toBeNull());
    expect(action.resolve?.(context)?.label).toBe("Add to Workboard");

    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    expect(action.resolve?.(context)?.label).toBe("Open Workboard card");

    const pending = createDeferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    const count = request.mock.calls.length;
    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count + 1));
    mounted?.dispose?.();
    dispose?.();
    disposed = true;
    const invalidations = vi.mocked(host.ui.invalidate).mock.calls.length;
    pending.resolve({ cards: [{ ...card, title: "Retired response" }], boards });
    await pending.promise;
    fixture.emit("plugin.workboard.changed", {});
    fixture.notify();
    expect(request).toHaveBeenCalledTimes(count + 1);
    expect(vi.mocked(host.ui.invalidate).mock.calls.length).toBe(invalidations);
    expect(container.childElementCount).toBe(0);
    expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
  } finally {
    if (!disposed) {
      mounted?.dispose?.();
      dispose?.();
    }
  }
});
