import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { ControlUiSessionListResult } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import {
  createGatewaySession,
  createWorkboardCard,
} from "../../lib/workboard/test/index-helpers.ts";
import { createWorkboardSessionAction } from "../../session-action.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { createWorkboardPage } from "./workboard-page.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
});

function mountPage(params: { boardId?: string; connected?: boolean; presented?: boolean } = {}) {
  const fixture = workboardTestHost();
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(fixture.host.agents, { rows: [], defaultId: null });
  let agents: AgentsListResult["agents"] = [{ id: "main" }, { id: "writer" }];
  let cards = [createWorkboardCard({ title: "Initial card" })];
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [...agents],
      };
    }
    if (method === "workboard.cards.list") {
      return { cards };
    }
    if (method === "tasks.list") {
      return { tasks: [] };
    }
    return {};
  });
  fixture.host.request = request as typeof fixture.host.request;
  fixture.host.agents.refresh = vi.fn(async () => {
    const result = await fixture.host.request<AgentsListResult>("agents.list", {});
    Object.assign(fixture.host.agents, { rows: result.agents, defaultId: result.defaultId });
    fixture.notify();
  });
  const container = document.createElement("div");
  document.body.append(container);
  let context = createViewContext<Readonly<Record<string, string>>>(
    fixture.host,
    params.boardId ? { boardId: params.boardId } : {},
    params.presented ?? true,
  );
  const mounted = createWorkboardPage(workboard)(container, context);
  cleanup.push(() => {
    mounted?.dispose?.();
    workboard.dispose();
  });
  return {
    fixture,
    workboard,
    container,
    request,
    cards(next: typeof cards) {
      cards = next;
    },
    agents(next: typeof agents) {
      agents = next;
    },
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    present(presented: boolean) {
      context = { ...context, presented };
      mounted?.update?.(context);
    },
    dispose() {
      mounted?.dispose?.();
    },
  };
}

function observeSessions(page: ReturnType<typeof mountPage>, result: ControlUiSessionListResult) {
  return vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result, loading: false, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
}

it("loads and refreshes cards through the plugin's authenticated host", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  page.cards([createWorkboardCard({ title: "Updated card" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Updated card"));
  expect(page.container.textContent).not.toContain("Initial card");
});

it.each([
  {
    link: "subagent:workboard-default-writer",
    key: "agent:writer:subagent:workboard-default-writer",
  },
  { link: "agent:writer:existing", key: "agent:writer:existing" },
])(
  "resolves an open $link card independently of the filtered session roster",
  async ({ link, key }) => {
    const page = mountPage();
    const session = createGatewaySession({ key, agentId: "writer" });
    const primaryRows = [createGatewaySession({ key: "global", agentId: "main", kind: "global" })];
    const observe = observeSessions(page, { sessions: [session], hasMore: false });
    Object.assign(page.fixture.host.sessions, { rows: primaryRows });
    const card = createWorkboardCard({ agentId: "main", sessionKey: link });
    page.cards([card]);
    page.workboard.state.detailCardId = card.id;
    page.fixture.connection.connected = true;
    page.fixture.notify();

    await vi.waitFor(() =>
      expect(page.fixture.host.components.mountDashboard).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ session: { sessionKey: key, agentId: "writer" } }),
      ),
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        search: link,
        archived: "all",
        limit: 2,
        includeGlobal: false,
        includeUnknown: false,
      }),
      expect.any(Function),
    );
    expect(page.fixture.host.sessions.rows).toEqual(primaryRows);
    expect(page.fixture.host.sessions.refresh).not.toHaveBeenCalled();
    page.container.querySelector<HTMLButtonElement>('button[aria-label="Open session"]')!.click();
    expect(page.fixture.host.sessions.open).toHaveBeenCalledWith({
      sessionKey: key,
      agentId: "writer",
    });
  },
);

it.each(["global", "unknown"] as const)(
  "keeps a bare %s link unresolved despite an ambient roster owner",
  async (key) => {
    const page = mountPage();
    const ambient = createGatewaySession({ key, kind: key, agentId: "main" });
    const exact = createGatewaySession({ key: "agent:writer:existing", agentId: "writer" });
    Object.assign(page.fixture.host.sessions, { rows: [ambient, exact] });
    const observe = observeSessions(page, { sessions: [ambient], hasMore: false });
    const card = createWorkboardCard({ agentId: "writer", sessionKey: key });
    page.cards([card]);
    page.fixture.connection.connected = true;
    page.fixture.notify();

    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-card")?.textContent).toContain(
        "Session state unknown",
      ),
    );
    expect(page.container.querySelector('button[aria-label="Open session"]')).toBeNull();
    expect(page.container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    expectDefined(
      page.container.querySelector<HTMLButtonElement>('button[aria-label="View details"]'),
      "open unresolved card details",
    ).click();
    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(
        "Session link ambiguous",
      ),
    );
    expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(
      "Edit the card to select an exact session",
    );
    expect(observe).not.toHaveBeenCalled();
    expect(page.fixture.host.components.mountDashboard).not.toHaveBeenCalled();
    expect(page.container.querySelector('button[aria-label="Open session"]')).toBeNull();
    expectDefined(
      page.container.querySelector<HTMLButtonElement>(
        '.workboard-detail button[aria-label="Edit card"]',
      ),
      "recover the unresolved link",
    ).click();
    await vi.waitFor(() =>
      expect(
        page.container.querySelector('.workboard-draft select[aria-label="Session"]'),
      ).not.toBeNull(),
    );
    const select = expectDefined(
      page.container.querySelector<HTMLSelectElement>(
        '.workboard-draft select[aria-label="Session"]',
      ),
      "session link editor",
    );
    expect(select.value).toBe(key);
    expect([...select.options].map((option) => option.value)).toContain(exact.key);
  },
);

it.each([
  {
    name: "incomplete",
    owners: ["writer"],
    hasMore: true,
    totalCount: 2,
    label: "Session state unknown",
  },
  {
    name: "deletion-filtered",
    owners: ["writer"],
    hasMore: false,
    totalCount: 2,
    label: "Session state unknown",
  },
  {
    name: "ambiguous",
    owners: ["writer", "other"],
    hasMore: false,
    totalCount: 2,
    label: "Session link ambiguous",
  },
  { name: "empty", owners: [], hasMore: false, totalCount: 0, label: "Session unavailable" },
])(
  "keeps an $name linked-session query unresolved",
  async ({ owners, hasMore, totalCount, label }) => {
    const page = mountPage();
    const localKey = "subagent:workboard-default-unresolved";
    const observe = observeSessions(page, {
      sessions: owners.map((owner) => createGatewaySession({ key: `agent:${owner}:${localKey}` })),
      hasMore,
      totalCount,
    });
    Object.assign(page.fixture.host.sessions, {
      rows: [createGatewaySession({ key: "agent:main:unrelated" })],
    });
    const card = createWorkboardCard({ sessionKey: localKey });
    page.cards([card]);
    page.workboard.state.detailCardId = card.id;
    page.fixture.connection.connected = true;
    page.fixture.notify();

    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(page.container.textContent).toContain(label));
    expect(page.fixture.host.components.mountDashboard).not.toHaveBeenCalled();

    page.container.querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')!.click();
    await vi.waitFor(() =>
      expect(
        page.container.querySelector('.workboard-draft select[aria-label="Session"]'),
      ).not.toBeNull(),
    );
    const select = page.container.querySelector<HTMLSelectElement>(
      '.workboard-draft select[aria-label="Session"]',
    )!;
    expect(select.value).toBe(localKey);
    for (const owner of owners) {
      expect([...select.options].map((option) => option.value)).toContain(
        `agent:${owner}:${localKey}`,
      );
    }
  },
);

it("releases the prior session query when another card takes the drawer", async () => {
  const page = mountPage();
  const firstKey = "subagent:workboard-default-first";
  const secondKey = "subagent:workboard-default-second";
  const first = createWorkboardCard({ id: "first", sessionKey: firstKey });
  const second = createWorkboardCard({ id: "second", sessionKey: secondKey });
  const releaseFirst = vi.fn();
  const observe = observeSessions(page, {
    sessions: [createGatewaySession({ key: `agent:writer:${secondKey}` })],
    hasMore: false,
  }).mockImplementationOnce((_query, listener) => {
    listener({ result: null, loading: true, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: releaseFirst };
  });
  page.cards([first, second]);
  page.workboard.state.detailCardId = first.id;
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());

  page.workboard.state.detailCardId = second.id;
  page.workboard.notify();
  await vi.waitFor(() =>
    expect(page.fixture.host.components.mountDashboard).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ session: { sessionKey: `agent:writer:${secondKey}` } }),
    ),
  );
  expect(page.fixture.host.components.mountDashboard).not.toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ session: { sessionKey: `agent:main:${firstKey}` } }),
  );
  expect(observe).toHaveBeenCalledTimes(2);
  expect(releaseFirst).toHaveBeenCalledOnce();
});

it("keeps failed metadata visible through card refreshes and recovers it with page Refresh", async () => {
  const page = mountPage();
  page.agents([{ id: "main", name: "Configured operator" }]);
  page.cards([createWorkboardCard({ title: "Initial card", agentId: "main" })]);
  const metadata = createDeferred<unknown>();
  const request = page.request.getMockImplementation()!;
  let metadataAvailable = false;
  page.request.mockImplementation((method) =>
    method === "agents.list" && !metadataAvailable ? metadata.promise : request(method),
  );
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  metadata.reject(new Error("Agent metadata temporarily unavailable"));
  await vi.waitFor(() =>
    expect(page.container.textContent).toContain("Agent metadata temporarily unavailable"),
  );

  page.cards([createWorkboardCard({ title: "Updated card", agentId: "main" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Updated card"));
  expect(page.container.textContent).toContain("Agent metadata temporarily unavailable");
  expect(page.container.querySelector(".workboard-board")?.textContent).not.toContain(
    "Configured operator",
  );
  expect(page.request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);

  metadataAvailable = true;
  page.container.querySelector<HTMLButtonElement>(".workboard-toolbar__actions button")!.click();
  await vi.waitFor(() =>
    expect(page.container.querySelector(".workboard-board")?.textContent).toContain(
      "Configured operator",
    ),
  );
  expect(page.container.textContent).not.toContain("Agent metadata temporarily unavailable");
  expect(page.container.textContent).toContain("Updated card");
  expect(page.request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
});

it("requires a canonical refresh after reconnect before mutations resume", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  page.fixture.connection.connected = false;
  page.fixture.notify();
  expect(page.workboard.state.mutationReadiness).toBe("canonical_reload_required");
  page.cards([createWorkboardCard({ title: "Reconnected card" })]);
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.container.textContent).toContain("Reconnected card"));
  expect(page.workboard.state.mutationReadiness).toBe("ready");
});

it("releases listeners and stops refreshes when its mount is disposed", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  page.dispose();
  const count = page.request.mock.calls.length;
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 9 });
  page.fixture.notify();
  await Promise.resolve();
  expect(page.request).toHaveBeenCalledTimes(count);
  expect(page.fixture.listeners.size).toBe(0);
  expect(page.fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  expect(page.container.childElementCount).toBe(0);
});

it.each([
  { scenario: "a previously presented page remains hidden", presented: true, dispose: false },
  { scenario: "a never-presented page is disposed", presented: false, dispose: true },
])("captures a session while $scenario", async ({ presented, dispose }) => {
  const page = mountPage({ connected: true, presented });
  await vi.waitFor(() => expect(page.fixture.host.agents.rows).toHaveLength(2));
  if (presented) {
    await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
    page.present(false);
    await Promise.resolve();
  }
  const session = createGatewaySession();
  const card = createWorkboardCard({
    id: "captured-card",
    sessionKey: session.key,
    metadata: { automation: { boardId: "ops" } },
  });
  const list = createDeferred<unknown>();
  page.request.mockClear().mockImplementation(async (method) => {
    if (method === "workboard.cards.list") {
      return list.promise;
    }
    if (method === "chat.history") {
      return { messages: [] };
    }
    if (method === "workboard.cards.captureSession") {
      return { card };
    }
    throw new Error(`Unexpected capture request: ${method}`);
  });
  const host = page.fixture.host;
  const action = createWorkboardSessionAction(host, page.workboard, "session");
  const capture = Promise.resolve(
    action.run({ sessionKey: session.key, session, host, signal: host.signal }),
  );
  if (dispose) {
    page.dispose();
  }
  await vi.waitFor(() => expect(page.request).toHaveBeenCalledWith("workboard.cards.list", {}));
  list.resolve({ cards: [] });

  await expect(capture).resolves.toBeUndefined();
  expect(
    page.request.mock.calls.filter(([method]) => method === "workboard.cards.captureSession"),
  ).toHaveLength(1);
  expect(page.request).toHaveBeenCalledWith(
    "workboard.cards.captureSession",
    expect.objectContaining({ sessionKey: session.key }),
  );
  expect(page.workboard.state.detailCardId).toBe(card.id);
  expect(host.navigation.openPage).toHaveBeenCalledExactlyOnceWith({
    id: "workboard",
    path: ["ops"],
  });
});

it.each(["deleted", "archived"] as const)(
  "reloads a remotely %s cached session card before opening capture from a hidden page",
  async (state) => {
    const page = mountPage();
    const session = createGatewaySession();
    const cached = createWorkboardCard({ title: "Cached session card", sessionKey: session.key });
    page.cards([cached]);
    page.fixture.connection.connected = true;
    page.fixture.notify();
    await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
    page.present(false);
    await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(false));
    expect(page.workboard.state.cards[0]?.id).toBe(cached.id);
    page.cards(state === "deleted" ? [] : [{ ...cached, metadata: { archivedAt: 2 } }]);
    const resolved = createWorkboardCard({
      id: state === "deleted" ? "recaptured-card" : cached.id,
      title: state === "deleted" ? "Recaptured session" : "Restored session",
      sessionKey: session.key,
      updatedAt: 3,
    });
    const request = expectDefined(page.request.getMockImplementation(), "host request");
    page.request.mockClear().mockImplementation(async (method) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.captureSession" || method === "workboard.cards.archive") {
        page.cards([resolved]);
        return { card: resolved };
      }
      return request(method);
    });
    const host = page.fixture.host;
    const action = createWorkboardSessionAction(host, page.workboard, "session");

    await action.run({ sessionKey: session.key, session, host, signal: host.signal });

    expect(page.request).toHaveBeenCalledWith("workboard.cards.list", {});
    if (state === "deleted") {
      expect(page.request).toHaveBeenCalledWith(
        "workboard.cards.captureSession",
        expect.objectContaining({ sessionKey: session.key }),
      );
    } else {
      expect(page.request).toHaveBeenCalledWith("workboard.cards.archive", {
        id: cached.id,
        archived: false,
      });
    }
    expect(page.workboard.state.detailCardId).toBe(resolved.id);
    expect(page.workboard.state.cards).toEqual([expect.objectContaining(resolved)]);
    page.present(true);
    await vi.waitFor(() =>
      expect(page.container.querySelector("[data-test-dialog]")?.getAttribute("aria-label")).toBe(
        resolved.title,
      ),
    );
  },
);

it("keeps the capture destination when navigating while session history loads", async () => {
  const page = mountPage({ boardId: "ops" });
  const session = createGatewaySession();
  const card = createWorkboardCard({
    id: "captured-card",
    sessionKey: session.key,
    metadata: { automation: { boardId: "ops" } },
  });
  const history = createDeferred<unknown>();
  const request = expectDefined(page.request.getMockImplementation(), "host request");
  page.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list") {
      return {
        cards: [],
        boards: ["ops", "product"].map((id) => ({
          id,
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
        })),
      };
    }
    if (method === "chat.history") {
      return history.promise;
    }
    if (method === "workboard.cards.captureSession") {
      return { card };
    }
    return request(method);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  const host = page.fixture.host;
  const action = createWorkboardSessionAction(host, page.workboard, "session");
  const capture = Promise.resolve(
    action.run({ sessionKey: session.key, session, host, signal: host.signal }),
  );

  try {
    await vi.waitFor(() =>
      expect(page.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: session.key }),
      ),
    );
    page.navigate("product");
    await vi.waitFor(() => expect(page.workboard.state.boardFilter).toBe("product"));
    history.resolve({ messages: [] });

    await expect(capture).resolves.toBeUndefined();
    expect(page.request).toHaveBeenCalledWith(
      "workboard.cards.captureSession",
      expect.objectContaining({ sessionKey: session.key, boardId: "ops" }),
    );
  } finally {
    history.resolve({ messages: [] });
    await capture;
  }
});

describe("selection reconciliation", () => {
  it.each(["scope", "board"] as const)(
    "preserves a submitted edit through %s changes and failed-save recovery",
    async (change) => {
      const page = mountPage();
      const card = createWorkboardCard({
        title: "Original task",
        notes: "Original notes",
        agentId: "writer",
        metadata: { automation: { boardId: "ops" } },
      });
      page.cards([card]);
      page.fixture.host.agents.setScope("writer");
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
      expectDefined(
        page.container.querySelector<HTMLButtonElement>('button[aria-label="View details"]'),
        "open task details",
      ).click();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-detail")).not.toBeNull(),
      );
      expectDefined(
        page.container.querySelector<HTMLButtonElement>(
          '.workboard-detail button[aria-label="Edit card"]',
        ),
        "edit the selected task",
      ).click();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-draft")).not.toBeNull(),
      );
      const form = () =>
        expectDefined(
          page.container.querySelector<HTMLFormElement>(".workboard-draft"),
          "card editor",
        );
      const title = expectDefined(
        form().querySelector<HTMLInputElement>(".workboard-draft__title"),
        "draft title",
      );
      const notes = expectDefined(
        form().querySelector<HTMLTextAreaElement>(".workboard-draft__notes"),
        "draft notes",
      );
      title.value = "Submitted task";
      title.dispatchEvent(new InputEvent("input", { bubbles: true }));
      notes.value = "Keep these unsaved notes";
      notes.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const pending = createDeferred<unknown>();
      let updateResult = pending.promise;
      const request = expectDefined(page.request.getMockImplementation(), "host request");
      page.request.mockImplementation((method) =>
        method === "workboard.cards.update" ? updateResult : request(method),
      );
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() =>
        expect(page.request).toHaveBeenCalledWith("workboard.cards.update", {
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch: { title: title.value, notes: notes.value },
        }),
      );
      if (change === "scope") {
        page.fixture.host.agents.setScope("main");
      } else {
        page.navigate("product");
      }
      await Promise.resolve();
      const pendingTitle =
        page.container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value;
      const pendingNotes =
        page.container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value;
      const pendingBusy = form().getAttribute("aria-busy");
      const enabledControls = [
        ...form().querySelectorAll(
          "input:enabled, textarea:enabled, select:enabled, button:enabled",
        ),
      ];
      pending.reject(new Error("Save unavailable; retry this edit."));
      await vi.waitFor(() => expect(page.workboard.state.draftSaving).toBe(false));

      expect(pendingTitle).toBe("Submitted task");
      expect(pendingNotes).toBe("Keep these unsaved notes");
      expect(pendingBusy).toBe("true");
      expect(enabledControls).toHaveLength(0);
      const alert = expectDefined(form().querySelector('[role="alert"]'), "retry guidance");
      expect(alert.textContent).toBe("Save unavailable; retry this edit.");
      expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(form().querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
        "Submitted task",
      );
      expect(form().querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value).toBe(
        "Keep these unsaved notes",
      );
      const saved = { ...card, title: title.value, notes: notes.value, updatedAt: 2 };
      updateResult = Promise.resolve({ card: saved });
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(page.workboard.state.draftOpen).toBe(false));
      expect(
        page.request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
      ).toHaveLength(2);
      expect(page.workboard.state.cards.find((entry) => entry.id === card.id)).toMatchObject(saved);
      expect(page.container.querySelector(".workboard-draft, .workboard-detail")).toBeNull();
      const main = expectDefined(
        page.container.querySelector(".workboard-main"),
        "filtered board content",
      );
      expect(main.textContent).not.toContain(saved.title);
    },
  );

  it.each(["detail", "editor"])(
    "keeps a default-agent card's %s and draft when selecting its scope without metadata",
    async (surface) => {
      const page = mountPage();
      const card = createWorkboardCard({ title: "Default-agent card" });
      page.cards([card]);
      page.fixture.connection.assistantAgentId = "research";
      vi.mocked(page.fixture.host.agents.refresh).mockRejectedValue(
        new Error("Agent metadata unavailable"),
      );
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-card")?.textContent).toContain(card.title),
      );
      page.container.querySelector<HTMLButtonElement>('button[aria-label="View details"]')!.click();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-detail")).not.toBeNull(),
      );
      if (surface === "editor") {
        page.container
          .querySelector<HTMLButtonElement>('.workboard-detail button[aria-label="Edit card"]')!
          .click();
        await vi.waitFor(() =>
          expect(page.container.querySelector(".workboard-draft")).not.toBeNull(),
        );
      }
      const selector = surface === "editor" ? ".workboard-draft__title" : ".workboard-detail__note";
      const input = page.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      input.value = "Keep this draft";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(page.fixture.host.agents.defaultId).toBeNull();
      page.fixture.host.agents.setScope("research");
      await Promise.resolve();

      expect(
        page.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value,
      ).toBe("Keep this draft");
      expect(page.container.querySelector(".workboard-board")?.textContent).toContain(card.title);
      expect(page.fixture.host.agents.scopeId).toBe("research");
    },
  );

  it.each([
    { scope: "main", visible: false },
    { scope: null, visible: true },
  ])("keeps only overlays inside scope $scope", async ({ scope, visible }) => {
    const page = mountPage();
    page.workboard.state.cards = [createWorkboardCard({ id: "writer-card", agentId: "writer" })];
    page.fixture.host.agents.setScope("writer");
    await Promise.resolve();
    Object.assign(page.workboard.state, {
      detailCardId: "writer-card",
      detailCommentBody: "Draft comment",
      draftOpen: true,
      editingCardId: "writer-card",
    });
    page.fixture.host.agents.setScope(scope);
    await Promise.resolve();
    expect(page.workboard.state.detailCardId).toBe(visible ? "writer-card" : null);
    expect(page.workboard.state.detailCommentBody).toBe(visible ? "Draft comment" : "");
    expect(page.workboard.state.draftOpen).toBe(visible);
  });

  it.each([
    { boardId: "product", visible: false },
    { boardId: "__all__", visible: true },
  ])("reconciles overlays when navigating to $boardId", async ({ boardId, visible }) => {
    const page = mountPage({ boardId: "ops" });
    page.workboard.state.cards = [
      createWorkboardCard({ id: "ops-card", metadata: { automation: { boardId: "ops" } } }),
    ];
    Object.assign(page.workboard.state, {
      detailCardId: "ops-card",
      detailCommentBody: "Draft comment",
      draftOpen: true,
      editingCardId: "ops-card",
    });
    page.navigate(boardId);
    await Promise.resolve();
    expect(page.workboard.state.boardFilter).toBe(boardId);
    expect(page.workboard.state.detailCardId).toBe(visible ? "ops-card" : null);
    expect(page.workboard.state.draftOpen).toBe(visible);
  });

  it("preserves a new-card draft across board navigation", async () => {
    const page = mountPage({ boardId: "ops" });
    Object.assign(page.workboard.state, { draftOpen: true, draftTitle: "New operations task" });
    page.navigate("product");
    await Promise.resolve();
    expect(page.workboard.state.draftOpen).toBe(true);
    expect(page.workboard.state.draftTitle).toBe("New operations task");
  });

  it.each(["job-planning", undefined])(
    "links a board's automation only when attached: %s",
    async (automationJobId) => {
      const page = mountPage({ boardId: "planning" });
      page.workboard.state.boards = [
        {
          id: "planning",
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
          ...(automationJobId ? { automationJobId } : {}),
        },
      ];
      page.workboard.notify();
      await Promise.resolve();
      const link = page.container.querySelector<HTMLAnchorElement>(".workboard-automation-chip");
      expect(Boolean(link)).toBe(Boolean(automationJobId));
      if (automationJobId) {
        expect(link?.getAttribute("href")).toBe("/automations");
      }
    },
  );
});
