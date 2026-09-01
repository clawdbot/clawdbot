import "./test/dom.setup.ts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardExecution,
} from "./lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "./lib/workboard/types.ts";
import { createWorkboardPage } from "./pages/workboard/workboard-page.ts";
import { createWorkboardSessionAction } from "./session-action.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

const capabilities: ReturnType<typeof createWorkboardCapability>[] = [];
afterEach(() => {
  for (const capability of capabilities.splice(0)) {
    capability.dispose();
  }
});

function fixture(session = createGatewaySession()) {
  const { host, connection } = workboardTestHost();
  connection.connected = true;
  const workboard = createWorkboardCapability();
  capabilities.push(workboard);
  workboard.state.loaded = true;
  const action = createWorkboardSessionAction(host, workboard, "session");
  const context = { sessionKey: session.key, session, host, signal: host.signal };
  return { host, connection, workboard, action, context };
}

const capturedSessionCases = [
  {
    name: "the current session",
    sessionKey: "agent:main:dashboard:1",
    card: { sessionKey: "agent:main:dashboard:1" },
  },
  {
    name: "an agentless Workboard link with a recorded owner",
    sessionKey: "agent:main:subagent:workboard-default-card-1",
    card: {
      sessionKey: "subagent:workboard-default-card-1",
      execution: createWorkboardExecution({
        sessionKey: "agent:main:subagent:workboard-default-card-1",
      }),
    },
  },
  {
    name: "a historical attempt",
    sessionKey: "agent:main:dashboard:previous",
    card: {
      sessionKey: "agent:main:dashboard:current",
      metadata: {
        attempts: [
          {
            id: "previous-attempt",
            status: "failed",
            startedAt: 1,
            sessionKey: "agent:main:dashboard:previous",
          },
        ],
      },
    },
  },
  {
    name: "a recorded card event",
    sessionKey: "agent:main:dashboard:previous",
    card: {
      sessionKey: "agent:main:dashboard:current",
      events: [
        {
          id: "previous-event",
          kind: "attempt_started",
          at: 1,
          sessionKey: "agent:main:dashboard:previous",
        },
      ],
    },
  },
] satisfies { name: string; sessionKey: string; card: Partial<WorkboardCard> }[];

it("projects capture, existing-card, busy and permission states from the plugin owner", () => {
  const { action, context, workboard, connection } = fixture();
  expect(action.resolve?.(context)).toEqual({
    label: "Add to Workboard",
    disabled: false,
    hidden: false,
  });
  workboard.state.cards = [createWorkboardCard({ sessionKey: context.sessionKey })];
  expect(action.resolve?.(context)?.label).toBe("Open Workboard card");
  workboard.state.capturingSessionKeys.add(context.sessionKey);
  expect(action.resolve?.(context)?.disabled).toBe(true);
  connection.canWrite = false;
  expect(action.resolve?.(context)?.hidden).toBe(true);
});

it.each(["global", "unknown"] as const)(
  "hides capture for a bare %s link and rejects retained invocations without RPCs",
  async (key) => {
    const { action, context, host, workboard } = fixture(
      createGatewaySession({ key, kind: key, agentId: "writer" }),
    );
    const request = vi.fn(async (method: string) =>
      method === "chat.history"
        ? { messages: [] }
        : { card: createWorkboardCard({ sessionKey: key }) },
    );
    host.request = request as typeof host.request;

    expect(action.resolve?.(context)?.hidden).toBe(true);
    await expect(action.run(context)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(workboard.state.cards).toEqual([]);
    expect(host.navigation.openPage).not.toHaveBeenCalled();
  },
);

it.each(["agent:main:dashboard:1", "agent:writer:unknown"])(
  "captures the supplied %s row outside the host's loaded session subset",
  async (key) => {
    const { action, context, host, workboard } = fixture(createGatewaySession({ key }));
    const card = createWorkboardCard({
      sessionKey: context.sessionKey,
      metadata: { automation: { boardId: "ops" } },
    });
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? { messages: [] } : { card },
    );
    host.request = request as typeof host.request;
    expect(host.sessions.rows).toEqual([]);
    await action.run(context);
    expect(request).toHaveBeenCalledWith(
      "workboard.cards.captureSession",
      expect.objectContaining({
        sessionKey: context.sessionKey,
        title: context.session.displayName,
      }),
    );
    expect(workboard.state.detailCardId).toBe(card.id);
    expect(host.navigation.openPage).toHaveBeenCalledWith({
      id: "workboard",
      path: ["ops"],
    });
    expect(workboard.state.capturingSessionKeys.size).toBe(0);
  },
);

it.each([
  { name: "a newly captured unassigned card", existing: false, agentId: undefined, scope: null },
  { name: "an existing card reassigned to main", existing: true, agentId: "main", scope: null },
  {
    name: "an existing card in the current scope",
    existing: true,
    agentId: "writer",
    scope: "writer",
  },
])("opens $name in the destination page", async ({ existing, agentId, scope }) => {
  const { action, context, host, workboard } = fixture(
    createGatewaySession({ key: "agent:writer:dashboard:1" }),
  );
  Object.assign(host.agents, {
    rows: [{ id: "main" }, { id: "writer" }],
    defaultId: "main",
    selectedId: "writer",
    scopeId: "writer",
  });
  const card = createWorkboardCard({
    title: "Captured writer conversation",
    agentId,
    sessionKey: context.sessionKey,
    metadata: { automation: { boardId: "ops" } },
  });
  workboard.state.cards = existing ? [card] : [];
  const request = vi.fn(async (method: string) => {
    if (method === "chat.history") {
      return { messages: [] };
    }
    if (method === "workboard.cards.captureSession") {
      return { card };
    }
    if (method === "workboard.cards.list") {
      return {
        cards: [card],
        boards: [{ id: "ops", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }],
      };
    }
    return { tasks: [] };
  });
  host.request = request as typeof host.request;
  const destination = document.createElement("div");
  document.body.append(destination);
  let disposeDestination = () => {};
  vi.mocked(host.navigation.openPage).mockImplementation(({ path }) => {
    disposeDestination();
    const mounted = createWorkboardPage(workboard)(
      destination,
      createViewContext(host, { boardId: path?.[0] ?? "__all__" }),
    );
    disposeDestination = () => mounted?.dispose?.();
  });
  try {
    await action.run(context);

    await vi.waitFor(() =>
      expect(destination.querySelector("[data-test-dialog]")?.getAttribute("aria-label")).toBe(
        card.title,
      ),
    );
    expect(destination.querySelector(".workboard-board")?.textContent).toContain(card.title);
    expect(workboard.state.detailCardId).toBe(card.id);
    expect(host.agents.scopeId).toBe(scope);
    expect(host.agents.selectedId).toBe("writer");
    expect(
      request.mock.calls.filter(([method]) => method === "workboard.cards.captureSession"),
    ).toHaveLength(existing ? 0 : 1);
  } finally {
    disposeDestination();
    destination.remove();
  }
});

it.each(capturedSessionCases)("offers the existing card for $name", ({ sessionKey, card }) => {
  const { action, context, workboard } = fixture(createGatewaySession({ key: sessionKey }));
  workboard.state.cards = [createWorkboardCard(card)];
  expect(action.resolve?.(context)?.label).toBe("Open Workboard card");
});

it.each(capturedSessionCases)(
  "opens the existing card for $name without capturing it again",
  async ({ sessionKey, card }) => {
    const { action, context, host, workboard } = fixture(createGatewaySession({ key: sessionKey }));
    const existing = createWorkboardCard(card);
    workboard.state.cards = [existing];
    const request = vi.fn(async (method: string) =>
      method === "chat.history"
        ? { messages: [] }
        : { card: createWorkboardCard({ id: "duplicate", sessionKey }) },
    );
    host.request = request as typeof host.request;

    await action.run(context);

    expect(request).not.toHaveBeenCalled();
    expect(workboard.state.detailCardId).toBe(existing.id);
    expect(host.navigation.openPage).toHaveBeenCalledOnce();
  },
);

it.each(["active", "archived"] as const)(
  "captures the exact owner instead of reusing an ambiguous %s provisional card",
  async (state) => {
    const localKey = "subagent:workboard-default-shared";
    const session = createGatewaySession({
      key: `agent:research:${localKey}`,
      agentId: "research",
    });
    const { action, context, host, workboard } = fixture(session);
    Object.assign(host.sessions, {
      rows: [session, createGatewaySession({ key: `agent:writer:${localKey}`, agentId: "writer" })],
    });
    const provisional = createWorkboardCard({
      id: "provisional-card",
      agentId: "writer",
      sessionKey: localKey,
      metadata: state === "archived" ? { archivedAt: 1 } : {},
    });
    const captured = createWorkboardCard({ id: "captured-research", sessionKey: session.key });
    workboard.state.cards = [provisional];
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.archive") {
        return { card: { ...provisional, metadata: {} } };
      }
      if (method === "workboard.cards.captureSession") {
        return { card: captured };
      }
      throw new Error(`Unexpected capture request: ${method}`);
    });
    host.request = request as typeof host.request;

    await action.run(context);

    expect(request).toHaveBeenCalledWith(
      "workboard.cards.captureSession",
      expect.objectContaining({ sessionKey: session.key }),
    );
    expect(request.mock.calls.filter(([method]) => method === "workboard.cards.archive")).toEqual(
      [],
    );
    expect(workboard.state.detailCardId).toBe(captured.id);
    expect(
      workboard.state.cards.find((card) => card.id === provisional.id)?.metadata?.archivedAt,
    ).toBe(provisional.metadata?.archivedAt);
  },
);

it("restores an archived session card before opening it", async () => {
  const { action, context, host, workboard } = fixture();
  const card = createWorkboardCard({ sessionKey: context.sessionKey });
  workboard.state.cards = [{ ...card, metadata: { archivedAt: 1 } }];
  const request = vi.fn(async () => ({ card }));
  host.request = request as typeof host.request;
  expect(action.resolve?.(context)?.label).toBe("Add to Workboard");
  await action.run(context);
  expect(request).toHaveBeenCalledWith("workboard.cards.archive", { id: card.id, archived: false });
  expect(action.resolve?.(context)?.label).toBe("Open Workboard card");
  expect(host.navigation.openPage).toHaveBeenCalledOnce();
});

it("does not navigate when the source action is disposed while capture is pending", async () => {
  const { action, context, host } = fixture();
  const pending = createDeferred<unknown>();
  const request = vi.fn(async (method: string) =>
    method === "chat.history" ? { messages: [] } : pending.promise,
  );
  host.request = request as typeof host.request;
  const abort = new AbortController();
  const result = Promise.resolve(action.run({ ...context, signal: abort.signal }));
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("workboard.cards.captureSession", expect.anything()),
  );
  expect(action.resolve?.(context)?.disabled).toBe(true);
  abort.abort();
  pending.resolve({ card: createWorkboardCard({ sessionKey: context.sessionKey }) });
  await expect(result).rejects.toThrow();
  expect(host.navigation.openPage).not.toHaveBeenCalled();
});
