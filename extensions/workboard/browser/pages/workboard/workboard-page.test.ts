import "../../test/dom.setup.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
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

function mountPage(params: { boardId?: string; connected?: boolean } = {}) {
  const fixture = workboardTestHost();
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(fixture.host.agents, { rows: [{ id: "main" }, { id: "writer" }] });
  let cards = [createWorkboardCard({ title: "Initial card" })];
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [...fixture.host.agents.rows],
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
  const container = document.createElement("div");
  document.body.append(container);
  let context = createViewContext<Readonly<Record<string, string>>>(
    fixture.host,
    params.boardId ? { boardId: params.boardId } : {},
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
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    dispose() {
      mounted?.dispose?.();
    },
  };
}

it("loads and refreshes cards through the plugin's authenticated host", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  page.cards([createWorkboardCard({ title: "Updated card" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Updated card"));
  expect(page.container.textContent).not.toContain("Initial card");
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

describe("selection reconciliation", () => {
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
