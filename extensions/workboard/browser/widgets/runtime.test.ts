import type { ControlUiHost, ControlUiWidget } from "openclaw/plugin-sdk/control-ui";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../lib/workboard/types.ts";
import { workboardTestHost } from "../test/host.setup.ts";
import { createViewContext } from "../test/host.ts";
import { createWorkboardWidget } from "../widgets.ts";

const cards = [
  createWorkboardCard({
    id: "ready",
    title: "Ready card",
    status: "ready",
    agentId: "agent-a",
    metadata: { automation: { boardId: "ops" } },
  }),
  createWorkboardCard({
    id: "running",
    title: "Running card",
    status: "running",
    position: 2000,
    metadata: { automation: { boardId: "ops" } },
  }),
  createWorkboardCard({
    id: "done",
    title: "Done card",
    status: "done",
    position: 3000,
    metadata: { automation: { boardId: "ops" } },
  }),
];
const snapshot = (listedCards: WorkboardCard[] = cards) => ({
  cards: listedCards,
  statuses: ["ready", "running", "done"],
});
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

function setup(
  request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => snapshot()),
) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  fixture.host.request = request as ControlUiHost["request"];
  const mount = (
    kind: "mini" | "card" | "board",
    props: Record<string, unknown>,
    canMutate = true,
  ) => {
    const abort = new AbortController();
    const scopedRequest = vi.fn((method: string, params?: unknown) => request(method, params));
    const scopedHost = {
      ...fixture.host,
      signal: abort.signal,
      request: scopedRequest as ControlUiHost["request"],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const context = createViewContext(scopedHost, {
      sessionKey: "main",
      widget: { name: kind, props },
      canMutate,
      canGrant: true,
    });
    const mounted = createWorkboardWidget(fixture.host, kind)(container, context) as Exclude<
      ReturnType<ControlUiWidget["mount"]>,
      void
    >;
    const dispose = () => {
      abort.abort();
      mounted.dispose?.();
    };
    disposers.push(dispose);
    return {
      container,
      scopedRequest,
      dispose,
      setPresented: (presented: boolean) => mounted.update?.({ ...context, presented }),
    };
  };
  return { fixture, request, mount };
}

function changeStatus(container: HTMLElement, status = "running") {
  const select = container.querySelector("select")!;
  select.value = status;
  select.dispatchEvent(new Event("change"));
}

it("shares reads across distinct scoped hosts and releases the subscription with the last widget", async () => {
  const { fixture, request, mount } = setup();
  const mini = mount("mini", { boardId: "ops" });
  const card = mount("card", { cardId: "ready" });
  await vi.waitFor(() => {
    expect(mini.container.textContent).toContain("Running card");
    expect(card.container.textContent).toContain("Ready card");
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(mini.scopedRequest).not.toHaveBeenCalled();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
  mini.dispose();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
  card.dispose();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
});

it("deduplicates moves across widgets while issuing the mutation through the invoking view", async () => {
  const move = Promise.withResolvers<unknown>();
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.move" ? move.promise : snapshot(),
  );
  const { mount } = setup(request);
  const first = mount("card", { cardId: "ready" });
  const second = mount("card", { cardId: "ready" });
  await vi.waitFor(() => expect(second.container.querySelector("select")).not.toBeNull());
  changeStatus(first.container);
  changeStatus(second.container);
  expect(request.mock.calls.filter(([method]) => method === "workboard.cards.move")).toHaveLength(
    1,
  );
  expect(first.scopedRequest).toHaveBeenCalledWith("workboard.cards.move", {
    id: "ready",
    status: "running",
    position: 3000,
  });
  expect(second.scopedRequest).not.toHaveBeenCalled();
  move.resolve({ card: { ...cards[0], status: "running", position: 3000 } });
  await vi.waitFor(() => expect(second.container.querySelector("select")?.value).toBe("running"));
});

it("refreshes every widget after a change during an older pending list", async () => {
  const firstList = Promise.withResolvers<unknown>();
  const request = vi.fn(async () =>
    request.mock.calls.length === 1 ? firstList.promise : snapshot(),
  );
  const { fixture, mount } = setup(request);
  const mini = mount("mini", {});
  const card = mount("card", { cardId: "ready" });
  fixture.emit("plugin.workboard.changed", {});
  firstList.resolve(snapshot([]));
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(mini.container.textContent).toContain("Ready card");
    expect(card.container.textContent).toContain("Ready card");
  });
});

it("preserves a current queued refresh when an older connection completes", async () => {
  const oldList = Promise.withResolvers<unknown>();
  const currentList = Promise.withResolvers<unknown>();
  const request = vi.fn(async () =>
    request.mock.calls.length === 1
      ? oldList.promise
      : request.mock.calls.length === 2
        ? currentList.promise
        : snapshot(),
  );
  const { fixture, mount } = setup(request);
  const widget = mount("mini", {});
  fixture.connection.connected = false;
  fixture.notify();
  fixture.connection.connected = true;
  fixture.notify();
  fixture.emit("plugin.workboard.changed", {});
  oldList.resolve(snapshot([]));
  await oldList.promise;
  currentList.resolve(snapshot([]));
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledTimes(3);
    expect(widget.container.textContent).toContain("Running card");
  });
});

it("ignores a completed move from the previous connection", async () => {
  const move = Promise.withResolvers<unknown>();
  let current = false;
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.move"
      ? move.promise
      : snapshot(current ? [{ ...cards[0]!, title: "Current card" }] : cards),
  );
  const { fixture, mount } = setup(request);
  const widget = mount("card", { cardId: "ready" });
  await vi.waitFor(() => expect(widget.container.querySelector("select")).not.toBeNull());
  changeStatus(widget.container);
  fixture.connection.connected = false;
  fixture.notify();
  current = true;
  fixture.connection.connected = true;
  fixture.notify();
  await vi.waitFor(() => expect(widget.container.textContent).toContain("Current card"));
  move.resolve({ card: { ...cards[0], title: "Stale card", status: "running" } });
  await move.promise;
  await Promise.resolve();
  expect(widget.container.textContent).toContain("Current card");
  expect(widget.container.textContent).not.toContain("Stale card");
  expect(widget.container.querySelector("select")?.value).toBe("ready");
});

it("fences retained hidden controls while a visible peer retains the shared runtime", async () => {
  const { request, mount } = setup();
  const hidden = mount("card", { cardId: "ready" });
  const visible = mount("mini", {});
  await vi.waitFor(() => expect(visible.container.textContent).toContain("Ready card"));
  hidden.setPresented(false);
  changeStatus(hidden.container);
  expect(request).toHaveBeenCalledTimes(1);
  hidden.setPresented(true);
  expect(hidden.container.textContent).toContain("Ready card");
});

it.each([
  { name: "an empty destination", listed: [cards[0]!, cards[2]!], position: 1000 },
  {
    name: "another board's positions",
    listed: [
      ...cards,
      {
        ...cards[1]!,
        id: "other",
        position: 9000,
        metadata: { automation: { boardId: "product" } },
      },
    ],
    position: 3000,
  },
  {
    name: "archived positions on the same board",
    listed: [
      ...cards,
      {
        ...cards[1]!,
        id: "archived",
        position: 9000,
        metadata: { automation: { boardId: "ops" }, archivedAt: 10 },
      },
    ],
    position: 10000,
  },
])("uses the canonical move position with $name", async ({ listed, position }) => {
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.move"
      ? { card: { ...cards[0], status: "running", position } }
      : snapshot(listed),
  );
  const { mount } = setup(request);
  const widget = mount("card", { cardId: "ready" });
  await vi.waitFor(() => expect(widget.container.querySelector("select")).not.toBeNull());
  changeStatus(widget.container);
  expect(widget.scopedRequest).toHaveBeenCalledWith("workboard.cards.move", {
    id: "ready",
    status: "running",
    position,
  });
});

it.each(["mini", "board"] as const)(
  "scopes %s to an explicit board and excludes archived cards",
  async (kind) => {
    const other = {
      ...cards[0]!,
      id: "other",
      title: "Other card",
      metadata: { automation: { boardId: "product" } },
    };
    const archived = {
      ...cards[1]!,
      id: "archived",
      title: "Archived card",
      metadata: { automation: { boardId: "ops" }, archivedAt: 10 },
    };
    const { mount } = setup(vi.fn(async () => snapshot([...cards, other, archived])));
    const scoped = mount(kind, { boardId: "ops" });
    const all = mount(kind, {});
    await vi.waitFor(() => expect(all.container.textContent).toContain("Other card"));
    expect(scoped.container.textContent).toContain("Ready card");
    expect(scoped.container.textContent).not.toContain("Other card");
    expect(all.container.textContent).not.toContain("Archived card");
    if (kind === "mini") {
      const counts = [
        ...scoped.container.querySelectorAll(".workboard-widget-mini__counts span"),
      ].map((entry) => entry.textContent?.replace(/\s+/g, " ").trim());
      expect(counts).toEqual(expect.arrayContaining(["1 Ready", "1 Running", "1 Done"]));
      expect(scoped.container.querySelector("a")?.getAttribute("href")).toBe("/workboard/ops");
      expect(all.container.querySelector("a")?.getAttribute("href")).toBe("/workboard");
    } else {
      expect(scoped.container.querySelectorAll(".workboard-column")).toHaveLength(3);
    }
  },
);

it("does not render controls for an archived card", async () => {
  const { mount } = setup(
    vi.fn(async () => snapshot([{ ...cards[0]!, metadata: { archivedAt: 10 } }])),
  );
  const widget = mount("card", { cardId: "ready" });
  await vi.waitFor(() => expect(widget.container.textContent).toContain("no longer available"));
  expect(widget.container.querySelector("select")).toBeNull();
});

it("keeps every board control read-only", async () => {
  const { mount, request } = setup();
  const widget = mount("board", {}, false);
  await vi.waitFor(() => expect(widget.container.querySelectorAll("select")).toHaveLength(3));
  expect([...widget.container.querySelectorAll("select")].every((select) => select.disabled)).toBe(
    true,
  );
  changeStatus(widget.container);
  expect(request).toHaveBeenCalledTimes(1);
});
