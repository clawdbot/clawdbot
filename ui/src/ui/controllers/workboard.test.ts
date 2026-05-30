import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  archiveWorkboardCard,
  captureSessionToWorkboard,
  createWorkboardCard,
  deleteWorkboardCard,
  getWorkboardLifecycle,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  saveWorkboardCardDraft,
  startWorkboardCard,
  stopWorkboardCard,
  syncWorkboardLifecycle,
  type WorkboardCard,
} from "./workboard.ts";

function createClient(
  responses: Record<string, unknown> | ((method: string, params: unknown) => unknown),
) {
  const request = vi.fn(async (method: string, params: unknown) =>
    typeof responses === "function" ? responses(method, params) : responses[method],
  );
  return { request };
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver");
  }
  return { promise, resolve };
}

const sampleCard: WorkboardCard = {
  id: "card-1",
  title: "Build board",
  status: "todo",
  priority: "normal",
  labels: [],
  position: 1000,
  createdAt: 1,
  updatedAt: 1,
};

const sampleSession: GatewaySessionRow = {
  key: "agent:main:dashboard:1",
  kind: "direct",
  updatedAt: Date.now(),
  displayName: "Dashboard session",
  hasActiveRun: true,
  status: "running",
};

describe("workboard controller", () => {
  it("loads cards through the plugin gateway method", async () => {
    const host = {};
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
  });

  it("preserves automation metadata loaded from the plugin gateway method", async () => {
    const host = {};
    const client = createClient({
      "workboard.cards.list": {
        cards: [
          {
            ...sampleCard,
            metadata: {
              automation: {
                tenant: "qa",
                skills: ["testing"],
                workspace: { kind: "scratch" },
                dispatchCount: 2,
                lastDispatchAt: 20,
              },
            },
          },
        ],
        statuses: ["ready", "done"],
      },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(getWorkboardState(host).cards[0]?.metadata?.automation).toMatchObject({
      tenant: "qa",
      skills: ["testing"],
      workspace: { kind: "scratch" },
      dispatchCount: 2,
      lastDispatchAt: 20,
    });
  });

  it("creates cards from draft state", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.draftTitle = "Write tests";
    state.draftNotes = "Cover the happy path";
    state.draftSessionKey = "agent:main:dashboard:1";
    const created = {
      ...sampleCard,
      id: "card-2",
      title: "Write tests",
      sessionKey: "agent:main:dashboard:1",
    };
    const client = createClient({ "workboard.cards.create": { card: created } });

    await createWorkboardCard({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", {
      title: "Write tests",
      notes: "Cover the happy path",
      status: "todo",
      priority: "normal",
      labels: [],
      agentId: "",
      sessionKey: "agent:main:dashboard:1",
    });
    expect(state.cards[0]).toMatchObject({ id: "card-2", title: "Write tests" });
    expect(state.draftOpen).toBe(false);
    expect(state.draftSessionKey).toBe("");
  });

  it("creates template-backed cards from draft state", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.draftTitle = "Fix: flaky worker";
    state.draftTemplateId = "bugfix";
    const created = {
      ...sampleCard,
      id: "card-2",
      title: "Fix: flaky worker",
      metadata: { templateId: "bugfix" },
    } satisfies WorkboardCard;
    const client = createClient({ "workboard.cards.create": { card: created } });

    await createWorkboardCard({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.create",
      expect.objectContaining({
        title: "Fix: flaky worker",
        templateId: "bugfix",
      }),
    );
    expect(state.cards[0]?.metadata?.templateId).toBe("bugfix");
    expect(state.draftTemplateId).toBe("");
  });

  it("updates cards from draft state when editing", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.cards = [sampleCard];
    state.draftOpen = true;
    state.editingCardId = sampleCard.id;
    state.draftTitle = "Updated board";
    state.draftNotes = "New notes";
    state.draftStatus = "review";
    state.draftPriority = "high";
    state.draftLabels = "ui, polish";
    state.draftAgentId = "dev";
    state.draftSessionKey = sampleSession.key;
    const updated = {
      ...sampleCard,
      title: "Updated board",
      notes: "New notes",
      status: "review",
      priority: "high",
      labels: ["ui", "polish"],
      agentId: "dev",
      sessionKey: sampleSession.key,
    };
    const client = createClient({ "workboard.cards.update": { card: updated } });

    await saveWorkboardCardDraft({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        title: "Updated board",
        notes: "New notes",
        status: "review",
        priority: "high",
        labels: ["ui", "polish"],
        agentId: "dev",
        sessionKey: sampleSession.key,
      },
    });
    expect(state.cards[0]).toMatchObject({ title: "Updated board", status: "review" });
    expect(state.draftOpen).toBe(false);
    expect(state.editingCardId).toBeNull();
  });

  it("captures existing sessions as linked workboard cards", async () => {
    const host = {};
    const session = {
      ...sampleSession,
      label: "Fix login",
      status: "done",
      hasActiveRun: false,
    } as const;
    const created = {
      ...sampleCard,
      title: "Fix login",
      status: "review",
      sessionKey: sampleSession.key,
    } as const;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [], statuses: ["todo", "running", "review"] };
      }
      if (method === "chat.history") {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "Please investigate login" }] },
            { role: "assistant", content: [{ type: "text", text: "Found the issue." }] },
            { role: "user", content: [{ type: "text", text: "Please fix login" }] },
            { role: "assistant", content: [{ type: "text", text: "Implemented and tested." }] },
          ],
        };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    const card = await captureSessionToWorkboard({ host, client: client as never, session });

    expect(card).toMatchObject({ title: "Fix login", status: "review" });
    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.list", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: sampleSession.key,
      limit: 40,
      maxChars: 6000,
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.create", {
      title: "Fix login",
      notes: [
        `Session: ${sampleSession.key}`,
        "",
        "Recent user prompt: Please fix login",
        "",
        "Latest assistant note: Implemented and tested.",
      ].join("\n"),
      status: "review",
      priority: "normal",
      agentId: "",
      sessionKey: sampleSession.key,
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ sessionKey: sampleSession.key });
  });

  it("does not duplicate existing captured sessions", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const existing = {
      ...sampleCard,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [existing];
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("restores archived captured sessions instead of leaving them hidden", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const archived = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      metadata: { archivedAt: 10 },
    } satisfies WorkboardCard;
    const restored = {
      ...archived,
      metadata: {},
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [archived];
    const client = createClient({
      "workboard.cards.archive": { card: restored },
    });

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toMatchObject({ id: restored.id, sessionKey: sampleSession.key });
    expect(card?.metadata?.archivedAt).toBeUndefined();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: archived.id,
      archived: false,
    });
    expect(state.cards[0]?.metadata?.archivedAt).toBeUndefined();
  });

  it("does not start duplicate capture requests while a session is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.capturingSessionKeys.add(sampleSession.key);
    const existing = { ...sampleCard, sessionKey: sampleSession.key };
    state.cards = [existing];
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not create capture cards when the duplicate preflight list fails", async () => {
    const host = {};
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        throw new Error("list unavailable");
      }
      return {};
    });

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
  });

  it("waits for an in-flight Workboard load before capturing a session", async () => {
    const host = {};
    const list = createDeferred<unknown>();
    const created = { ...sampleCard, sessionKey: sampleSession.key };
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return list.promise;
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    const loading = loadWorkboard({ host, client: client as never, force: true });
    const captured = captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    await Promise.resolve();
    expect(client.request).toHaveBeenCalledTimes(1);
    list.resolve({ cards: [], statuses: ["todo"] });
    await loading;

    await expect(captured).resolves.toMatchObject({ sessionKey: sampleSession.key });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", expect.any(Object));
  });

  it("clamps long session labels before creating captured cards", async () => {
    const host = {};
    const longLabel = "x".repeat(220);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [], statuses: ["todo"] };
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: { ...sampleCard, title: `${"x".repeat(177)}...` } };
      }
      return {};
    });

    await captureSessionToWorkboard({
      host,
      client: client as never,
      session: { ...sampleSession, label: longLabel },
    });

    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.create",
      expect.objectContaining({
        title: `${"x".repeat(177)}...`,
      }),
    );
  });

  it("starts a session and links it back to the card", async () => {
    const host = {};
    const running = { ...sampleCard, status: "running", sessionKey: "agent:main:dashboard:1" };
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:1", runId: "run-1" },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBe("agent:main:dashboard:1");
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: { status: "running" },
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "sessions.create",
      expect.objectContaining({
        label: "Build board (card-1)",
        message: expect.stringContaining("Work on this OpenClaw Workboard card: Build board"),
      }),
    );
    expect(client.request.mock.calls[1]?.[1]).not.toHaveProperty("model");
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "running",
          runId: "run-1",
        }),
      }),
    );
    expect(client.request.mock.calls[2]?.[1]).toHaveProperty("patch.execution", null);
  });

  it("lets the gateway preflight decide starts when local parent state is stale", async () => {
    const host = {};
    const parent = { ...sampleCard, id: "parent-1", title: "Parent", status: "running" };
    const child: WorkboardCard = {
      ...sampleCard,
      id: "child-1",
      title: "Child",
      metadata: {
        links: [{ id: "link-1", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    };
    const running = { ...child, status: "running", sessionKey: "agent:main:dashboard:child" };
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [parent, child], statuses: ["todo", "running", "done"] };
      }
      if (method === "sessions.create") {
        return { key: "agent:main:dashboard:child" };
      }
      return { card: running };
    });
    await loadWorkboard({ host, client: client as never, force: true });
    client.request.mockClear();

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: child,
    });

    expect(sessionKey).toBe("agent:main:dashboard:child");
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({ id: child.id, patch: { status: "running" } }),
    );
  });

  it("does not create a session when the gateway rejects start preflight", async () => {
    const host = {};
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        throw new Error("Parent cards must be done before starting this card.");
      }
      return { key: "agent:main:dashboard:1" };
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.update",
      expect.objectContaining({ patch: { status: "running" } }),
    );
    expect(getWorkboardState(host).error).toBe(
      "Parent cards must be done before starting this card.",
    );
  });

  it("rolls back the running preflight when session creation fails", async () => {
    const host = {};
    const running = { ...sampleCard, status: "running" } satisfies WorkboardCard;
    let updateCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        updateCalls += 1;
        return { card: updateCalls === 1 ? running : sampleCard };
      }
      if (method === "sessions.create") {
        throw new Error("gateway disconnected");
      }
      return {};
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({ patch: { status: "running" } }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          status: "todo",
          startedAt: null,
          completedAt: null,
        }),
      }),
    );
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
    expect(getWorkboardState(host).error).toBe("gateway disconnected");
  });

  it("rolls back the running preflight when final session link update fails", async () => {
    const host = {};
    const running = { ...sampleCard, status: "running" } satisfies WorkboardCard;
    let updateCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          return { card: running };
        }
        if (updateCalls === 2) {
          throw new Error("write conflict");
        }
        return { card: sampleCard };
      }
      if (method === "sessions.create") {
        return { key: "agent:main:dashboard:1", runId: "run-1" };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["run-1"] };
      }
      return {};
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenNthCalledWith(
      4,
      "chat.abort",
      {
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
      },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      5,
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          status: "todo",
          startedAt: null,
          completedAt: null,
        }),
      }),
    );
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
    expect(getWorkboardState(host).error).toBe("write conflict");
  });

  it("does not start a card before its scheduled time", async () => {
    const host = {};
    const scheduled = {
      ...sampleCard,
      id: "scheduled-1",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [scheduled], statuses: ["scheduled", "running", "done"] },
    });
    await loadWorkboard({ host, client: client as never, force: true });
    client.request.mockClear();

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: scheduled,
    });

    expect(sessionKey).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(getWorkboardState(host).error).toBe(
      "Scheduled cards cannot start before their scheduled time.",
    );

    const manualScheduled = {
      ...sampleCard,
      id: "scheduled-2",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    } satisfies WorkboardCard;
    const manualLinked = {
      ...manualScheduled,
      status: "todo",
      metadata: {},
      sessionKey: "agent:main:dashboard:manual",
      execution: {
        id: "exec-manual",
        kind: "agent-session",
        engine: "codex",
        mode: "manual",
        status: "idle",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:manual",
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    const manualClient = createClient({
      "sessions.create": { key: "agent:main:dashboard:manual" },
      "workboard.cards.update": { card: manualLinked },
    });
    const manualSessionKey = await startWorkboardCard({
      host,
      client: manualClient as never,
      card: manualScheduled,
      mode: "manual",
    });
    expect(manualSessionKey).toBe("agent:main:dashboard:manual");
    expect(manualClient.request).toHaveBeenNthCalledWith(
      1,
      "sessions.create",
      expect.not.objectContaining({ message: expect.any(String) }),
    );
    expect(manualClient.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: manualScheduled.id,
        patch: expect.objectContaining({ status: "todo", scheduledAt: null }),
      }),
    );

    const readyWithSchedule = {
      ...sampleCard,
      id: "scheduled-2b",
      status: "ready",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    } satisfies WorkboardCard;
    const readyManualClient = createClient({
      "sessions.create": { key: "agent:main:dashboard:ready-manual" },
      "workboard.cards.update": {
        card: { ...readyWithSchedule, sessionKey: "agent:main:dashboard:ready-manual" },
      },
    });
    await startWorkboardCard({
      host,
      client: readyManualClient as never,
      card: readyWithSchedule,
      mode: "manual",
    });
    expect(readyManualClient.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: readyWithSchedule.id,
        patch: expect.objectContaining({ status: "ready", scheduledAt: null }),
      }),
    );

    const dueScheduled = {
      ...scheduled,
      id: "scheduled-3",
      metadata: { automation: { scheduledAt: Date.now() - 60_000 } },
    } satisfies WorkboardCard;
    const dueRunning = {
      ...dueScheduled,
      status: "running",
      sessionKey: "agent:main:dashboard:1",
    } satisfies WorkboardCard;
    const dueClient = createClient({
      "workboard.cards.list": { cards: [dueScheduled], statuses: ["scheduled", "running", "done"] },
      "sessions.create": { key: "agent:main:dashboard:1", runId: "run-1" },
      "workboard.cards.update": { card: dueRunning },
    });
    await loadWorkboard({ host, client: dueClient as never, force: true });
    dueClient.request.mockClear();

    const dueSessionKey = await startWorkboardCard({
      host,
      client: dueClient as never,
      card: dueScheduled,
    });

    expect(dueSessionKey).toBe("agent:main:dashboard:1");
    expect(dueClient.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        label: "Build board (schedule)",
      }),
    );
  });

  it("starts a Codex execution with an explicit model override", async () => {
    const host = {};
    const running = {
      ...sampleCard,
      status: "running",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "card-1:codex",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      },
    };
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:1", runId: "run-1" },
      "workboard.cards.update": { card: running },
    });

    await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
      engine: "codex",
    });

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({
        patch: { status: "running" },
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "sessions.create",
      expect.objectContaining({
        model: "openai/gpt-5.5",
        message: expect.stringContaining("Work on this OpenClaw Workboard card: Build board"),
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "running",
          execution: expect.objectContaining({
            engine: "codex",
            mode: "autonomous",
            model: "openai/gpt-5.5",
            runId: "run-1",
          }),
        }),
      }),
    );
  });

  it("resets execution start time when retrying a card run", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const host = {};
      const previous = {
        ...sampleCard,
        execution: {
          id: "card-1:codex",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "blocked",
          model: "openai/gpt-5.5",
          sessionKey: "agent:main:dashboard:1",
          runId: "run-1",
          startedAt: 10,
          updatedAt: 20,
        },
      } satisfies WorkboardCard;
      const client = createClient({
        "sessions.create": { key: "agent:main:dashboard:1", runId: "run-2" },
        "workboard.cards.update": { card: previous },
      });

      await startWorkboardCard({
        host,
        client: client as never,
        card: previous,
        engine: "codex",
      });

      expect(client.request).toHaveBeenNthCalledWith(
        3,
        "workboard.cards.update",
        expect.objectContaining({
          patch: expect.objectContaining({
            execution: expect.objectContaining({
              runId: "run-2",
              startedAt: 1234,
            }),
          }),
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("starts a manual Claude execution without sending the card prompt", async () => {
    const host = {};
    const running = {
      ...sampleCard,
      status: "todo",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "card-1:claude",
        kind: "agent-session",
        engine: "claude",
        mode: "manual",
        status: "idle",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    };
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:1", runStarted: false },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
      engine: "claude",
      mode: "manual",
    });

    expect(sessionKey).toBe("agent:main:dashboard:1");
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "sessions.create",
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-6",
      }),
    );
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("message");
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("task");
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "todo",
          execution: expect.objectContaining({
            engine: "claude",
            mode: "manual",
            status: "idle",
            model: "anthropic/claude-sonnet-4-6",
          }),
        }),
      }),
    );
  });

  it("blocks a card when the initial session run fails to start", async () => {
    const host = {};
    const blocked = { ...sampleCard, status: "blocked", sessionKey: "agent:main:dashboard:1" };
    const client = createClient({
      "sessions.create": {
        key: "agent:main:dashboard:1",
        runStarted: false,
        runError: { message: "provider unavailable" },
      },
      "workboard.cards.update": { card: blocked },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBe("agent:main:dashboard:1");
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "blocked",
          sessionKey: "agent:main:dashboard:1",
        }),
      }),
    );
    expect(client.request.mock.calls[2]?.[1]).toHaveProperty("patch.execution", null);
    expect(getWorkboardState(host).error).toBe("Agent run did not start: provider unavailable");
  });

  it("moves cards through the plugin gateway method", async () => {
    const host = {};
    const moved = { ...sampleCard, status: "blocked", position: 2000 };
    const client = createClient({ "workboard.cards.move": { card: moved } });

    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: "card-1",
      status: "blocked",
      position: 2000,
    });

    expect(getWorkboardState(host).cards[0]).toMatchObject({
      status: "blocked",
      position: 2000,
    });
  });

  it("removes stale dependency links from local cards after delete", async () => {
    const host = {};
    const parent: WorkboardCard = {
      ...sampleCard,
      id: "parent-1",
      title: "Parent",
      status: "done",
    };
    const child: WorkboardCard = {
      ...sampleCard,
      id: "child-1",
      title: "Child",
      metadata: {
        links: [{ id: "link-1", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    };
    const client = createClient((method) => {
      if (method === "workboard.cards.delete") {
        return { deleted: true };
      }
      if (method === "sessions.create") {
        return { key: "agent:main:dashboard:child", runId: "run-child" };
      }
      return { card: { ...child, status: "running", metadata: undefined } };
    });
    getWorkboardState(host).cards = [parent, child];

    await deleteWorkboardCard({
      host,
      client: client as never,
      cardId: parent.id,
    });

    const remaining = getWorkboardState(host).cards[0];
    expect(remaining).toMatchObject({ id: child.id });
    expect(remaining?.metadata?.links).toBeUndefined();

    client.request.mockClear();
    await startWorkboardCard({
      host,
      client: client as never,
      card: remaining,
    });

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({
        id: child.id,
        patch: { status: "running" },
      }),
    );
  });

  it("derives lifecycle state from linked dashboard sessions", () => {
    expect(getWorkboardLifecycle(sampleCard, [sampleSession])).toEqual({
      session: null,
      state: "unlinked",
    });

    const linked = { ...sampleCard, sessionKey: sampleSession.key };
    expect(getWorkboardLifecycle(linked, [sampleSession])).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "running" }]),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "done" }]),
    ).toMatchObject({
      state: "succeeded",
      targetStatus: "review",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "failed" }]),
    ).toMatchObject({
      state: "failed",
      targetStatus: "blocked",
    });
    expect(
      getWorkboardLifecycle(linked, [
        {
          ...sampleSession,
          hasActiveRun: false,
          status: "running",
          updatedAt: Date.now() - 31 * 60 * 1000,
        },
      ]),
    ).toMatchObject({
      state: "stale",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [
        { ...sampleSession, hasActiveRun: true, updatedAt: Date.now() - 31 * 60 * 1000 },
      ]),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [
        { ...sampleSession, hasActiveRun: undefined, updatedAt: Date.now() - 31 * 60 * 1000 },
      ]),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(
        {
          ...sampleCard,
          execution: {
            id: "exec-1",
            kind: "agent-session",
            engine: "codex",
            mode: "autonomous",
            status: "running",
            model: "openai/gpt-5.5",
            sessionKey: sampleSession.key,
            startedAt: 1,
            updatedAt: 1,
          },
        },
        [sampleSession],
      ),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
  });

  it("syncs linked card status from session lifecycle without overriding manual review", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      { ...sampleCard, sessionKey: sampleSession.key },
      { ...sampleCard, id: "card-review", status: "review", sessionKey: "session-review" },
    ];
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: { ...sampleCard, status: "running", sessionKey: sampleSession.key } };
      }
      return {};
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [
        sampleSession,
        { ...sampleSession, key: "session-review", status: "failed", hasActiveRun: false },
      ],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { status: "running" },
    });
    expect(state.cards.find((card) => card.id === "card-review")?.status).toBe("review");
  });

  it("moves stale running sessions into running while recording stale metadata", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const staleUpdatedAt = Date.now() - 31 * 60 * 1000;
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      metadata: {
        comments: [{ id: "comment-1", body: "Keep me", createdAt: 1 }],
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: {
          ...linked,
          status: "running",
          metadata: {
            stale: {
              detectedAt: 1,
              lastSessionUpdatedAt: staleUpdatedAt,
              reason: "Linked session has not reported recent activity.",
            },
          },
        },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, updatedAt: staleUpdatedAt, hasActiveRun: false }],
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        status: "running",
        metadata: {
          stale: expect.objectContaining({
            lastSessionUpdatedAt: staleUpdatedAt,
            reason: "Linked session has not reported recent activity.",
          }),
        },
      },
    });
  });

  it("syncs stale session metadata and clears it when the session recovers", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      metadata: {
        comments: [{ id: "comment-1", body: "Keep me", createdAt: 1 }],
        stale: {
          detectedAt: 1,
          lastSessionUpdatedAt: 1,
          reason: "Linked session has not reported recent activity.",
        },
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, metadata: undefined, updatedAt: 3 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, updatedAt: Date.now(), hasActiveRun: true }],
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        metadata: {
          stale: null,
        },
      },
    });
  });

  it("does not rewrite unchanged stale session metadata", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const staleUpdatedAt = Date.now() - 31 * 60 * 1000;
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      metadata: {
        stale: {
          detectedAt: 1,
          lastSessionUpdatedAt: staleUpdatedAt,
          reason: "Linked session has not reported recent activity.",
        },
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({ "workboard.cards.update": { card: linked } });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, updatedAt: staleUpdatedAt, hasActiveRun: false }],
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not mark executions blocked when the linked session is missing from the current list", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: "agent:main:dashboard:missing",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:missing",
        startedAt: 1,
        updatedAt: 1,
      },
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({ "workboard.cards.update": { card: linked } });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it("skips lifecycle writeback for read-only workboard clients", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
    const client = createClient(() => {
      throw new Error("write denied");
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [sampleSession],
      canWrite: false,
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.error).toBeNull();
  });

  it("resyncs cards manually moved back to an active lifecycle column", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      updatedAt: 1000,
    } as const;
    const completedSession = {
      ...sampleSession,
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, status: "review", updatedAt: 3000 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });
    state.cards = [{ ...linked, updatedAt: 4000 }];
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed lifecycle sync for the same card and session state", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      updatedAt: 1000,
    } as const;
    const completedSession = {
      ...sampleSession,
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient(() => {
      throw new Error("write denied");
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(state.error).toBe("write denied");
  });

  it("stops linked sessions and marks cards blocked", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "run-1" };
    const blocked = { ...linked, status: "blocked" };
    const client = createClient({
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
  });

  it("archives cards through the plugin gateway method", async () => {
    const host = {};
    const archived = {
      ...sampleCard,
      metadata: { archivedAt: 20 },
    } satisfies WorkboardCard;
    const client = createClient({ "workboard.cards.archive": { card: archived } });

    await archiveWorkboardCard({
      host,
      client: client as never,
      cardId: "card-1",
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: "card-1",
      archived: true,
    });
    expect(getWorkboardState(host).cards[0]?.metadata?.archivedAt).toBe(20);
  });

  it("falls back to the active session abort when the stored run id is stale", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "old-run" };
    const blocked = { ...linked, status: "blocked" };
    const client = createClient((method, params) => {
      if (method === "chat.abort" && (params as { runId?: string }).runId === "old-run") {
        return { aborted: false, runIds: [] };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["new-run"] };
      }
      return { card: blocked };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "old-run",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
  });

  it("leaves cards unchanged when stop does not abort an active run", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "stale-run" };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient({
      "chat.abort": { aborted: false, runIds: [] },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "stale-run",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(state.cards).toEqual([linked]);
  });
});
