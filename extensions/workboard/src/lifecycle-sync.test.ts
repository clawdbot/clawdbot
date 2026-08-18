import type { WorkboardExecution, WorkboardStatus } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./lifecycle-sync.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { workboardSessionKeyForCard } from "./session-link.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

function execution(
  sessionKey: string,
  runId = "run-1",
  status: WorkboardExecution["status"] = "running",
): WorkboardExecution {
  return {
    id: `exec-${runId}`,
    kind: "agent-session",
    mode: "autonomous",
    status,
    sessionKey,
    runId,
    startedAt: 1000,
    updatedAt: 1000,
  };
}

async function createLinkedCard(
  store: WorkboardStore,
  options: {
    status?: WorkboardStatus;
    sessionKey?: string;
    runId?: string;
    execution?: WorkboardExecution;
    agentId?: string;
    boardId?: string;
  } = {},
) {
  return await store.create({
    title: "Gateway-owned lifecycle",
    status: options.status ?? "running",
    sessionKey: options.sessionKey,
    runId: options.runId,
    execution: options.execution,
    agentId: options.agentId,
    boardId: options.boardId,
  });
}

async function runSessionSweep(params: {
  store: WorkboardStore;
  sessions: Array<{
    key: string;
    updatedAt?: number;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    hasActiveRun?: boolean;
    abortedLastRun?: boolean;
  }>;
  complete?: boolean;
  now?: number;
}) {
  const readSessions = vi.fn().mockResolvedValue({
    sessions: params.sessions,
    complete: params.complete ?? true,
  });
  const now = params.now;
  const service = createWorkboardLifecycleService({
    store: params.store,
    readSessions,
    ...(now === undefined ? {} : { now: () => now }),
  });
  await service.start({ logger: { warn: vi.fn() } } as never);
  service.onGatewayStart();
  await vi.waitFor(() => expect(readSessions).toHaveBeenCalledOnce());
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  service.onGatewayStop();
  await service.stop?.({ logger: { warn: vi.fn() } } as never);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Workboard gateway lifecycle sync", () => {
  it("nudges the attached board automation when a matching subagent ends", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-1";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const service = createWorkboardAutomationNudgeService({ store, gateway: { request } });
    const info = vi.fn();
    const context = { logger: { info, warn: vi.fn() } } as never;
    await service.start(context);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
      onMatched: service.nudge,
    });
    await service.stop?.(context);

    expect(request).toHaveBeenCalledWith(
      "cron.run",
      { id: "job-categorize-planning", mode: "if-enabled" },
      { scopes: ["operator.admin"] },
    );
    expect(info).toHaveBeenCalledWith(
      "workboard automation nudge requested for board planning: job job-categorize-planning",
    );
  });

  it("uses the active service owner from a prepared plugin generation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-generation";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const activeRequest = vi.fn();
    const activeService = createWorkboardAutomationNudgeService({
      store,
      gateway: { request: activeRequest },
    });
    const generationRequest = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const generationService = createWorkboardAutomationNudgeService({
      store,
      gateway: { request: generationRequest },
    });
    const context = { logger: { info: vi.fn(), warn: vi.fn() } } as never;
    await activeService.start(context);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
      onMatched: generationService.nudge,
    });
    await activeService.stop?.(context);

    expect(activeRequest).not.toHaveBeenCalled();
    expect(generationRequest).toHaveBeenCalledWith(
      "cron.run",
      { id: "job-categorize-planning", mode: "if-enabled" },
      { scopes: ["operator.admin"] },
    );
  });

  it("does not nudge a matching card whose board has no automation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.upsertBoard({ id: "planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-2";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store, gateway: { request } });
    const context = { logger: { info: vi.fn(), warn: vi.fn() } } as never;
    await service.start(context);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
      onMatched: service.nudge,
    });
    await service.stop?.(context);

    expect(request).not.toHaveBeenCalled();
  });

  it.each(["cron:job-categorize-planning", "agent:main:cron:job-categorize-planning:run:run-1"])(
    "does not nudge from cron-originated session %s",
    async (sessionKey) => {
      const store = new WorkboardStore(createMemoryStore());
      await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
      const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
      const request = vi.fn();
      const service = createWorkboardAutomationNudgeService({ store, gateway: { request } });
      const context = { logger: { info: vi.fn(), warn: vi.fn() } } as never;
      await service.start(context);

      await syncWorkboardSubagentEnded({
        store,
        event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
        onMatched: service.nudge,
      });
      await service.stop?.(context);

      expect(request).not.toHaveBeenCalled();
    },
  );

  it("coalesces repeated board nudges within the debounce window", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-3";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    let resolveRun: (value: unknown) => void = () => undefined;
    const run = new Promise<unknown>((resolve) => {
      resolveRun = resolve;
    });
    const request = vi.fn().mockReturnValue(run);
    const service = createWorkboardAutomationNudgeService({ store, gateway: { request } });
    const context = { logger: { info: vi.fn(), warn: vi.fn() } } as never;
    await service.start(context);
    const event = {
      targetSessionKey: sessionKey,
      endedAt: card.updatedAt + 1,
      outcome: "ok" as const,
    };

    const first = syncWorkboardSubagentEnded({ store, event, onMatched: service.nudge });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await syncWorkboardSubagentEnded({ store, event, onMatched: service.nudge });
    resolveRun({ ok: true, ran: true });
    await first;
    await syncWorkboardSubagentEnded({ store, event, onMatched: service.nudge });
    await service.stop?.(context);

    expect(request).toHaveBeenCalledOnce();
  });

  it("swallows nudge failures without affecting lifecycle sync", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-4";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const warn = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store, gateway: { request } });
    const context = { logger: { info: vi.fn(), warn } } as never;
    await service.start(context);

    await expect(
      syncWorkboardSubagentEnded({
        store,
        event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
        onMatched: service.nudge,
      }),
    ).resolves.toBe(1);
    await service.stop?.(context);

    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workboard automation nudge failed"));
  });

  it("logs disabled automation skips without affecting lifecycle sync", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-disabled";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: false, reason: "disabled" });
    const warn = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store, gateway: { request } });
    const context = { logger: { info: vi.fn(), warn } } as never;
    await service.start(context);

    await expect(
      syncWorkboardSubagentEnded({
        store,
        event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
        onMatched: service.nudge,
      }),
    ).resolves.toBe(1);
    await service.stop?.(context);

    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
    expect(warn).toHaveBeenCalledWith(
      "workboard automation nudge skipped for board planning: job job-categorize-planning disabled",
    );
  });

  it("moves a linked running card to review from the subagent hook without UI involvement", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:subagent:workboard-default-card-1";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-1",
      execution: execution(sessionKey),
    });
    const changes = vi.fn();
    store.subscribeChanges(changes);
    const endedAt = card.updatedAt + 1;

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, runId: "run-1", endedAt, outcome: "ok" },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      execution: { status: "review" },
      metadata: { lifecycleStatusSourceUpdatedAt: endedAt },
    });
    expect(changes).toHaveBeenCalledOnce();
  });

  it.each(["error", "timeout", "killed"] as const)(
    "moves a linked running card to blocked for subagent outcome %s",
    async (outcome) => {
      const store = new WorkboardStore(createMemoryStore());
      const sessionKey = `agent:main:subagent:workboard-default-${outcome}`;
      const card = await createLinkedCard(store, {
        sessionKey,
        runId: `run-${outcome}`,
        execution: execution(sessionKey, `run-${outcome}`),
      });

      await syncWorkboardSubagentEnded({
        store,
        event: {
          targetSessionKey: sessionKey,
          runId: `run-${outcome}`,
          endedAt: card.updatedAt + 1,
          outcome,
        },
      });

      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "blocked",
        execution: { status: "blocked" },
        metadata: { failureCount: 1 },
      });
    },
  );

  it("updates execution attempts once when duplicate failure hooks arrive", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:subagent:workboard-default-failure";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-failure",
      execution: execution(sessionKey, "run-failure"),
    });
    const event = {
      targetSessionKey: sessionKey,
      runId: "run-failure",
      endedAt: card.updatedAt + 1,
      outcome: "error" as const,
    };

    await syncWorkboardSubagentEnded({ store, event });
    await syncWorkboardSubagentEnded({ store, event });

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { failureCount: 1, attempts: [expect.objectContaining({ status: "blocked" })] },
    });
  });

  it.each(["review", "blocked", "done"] as const)(
    "keeps a manually moved %s card in place",
    async (status) => {
      const store = new WorkboardStore(createMemoryStore());
      const sessionKey = `agent:main:subagent:workboard-default-${status}`;
      const card = await createLinkedCard(store, { status, sessionKey, runId: `run-${status}` });

      await syncWorkboardSubagentEnded({
        store,
        event: {
          targetSessionKey: sessionKey,
          runId: `run-${status}`,
          endedAt: card.updatedAt + 1,
          outcome: status === "blocked" ? "error" : "ok",
        },
      });

      expect((await store.get(card.id))?.status).toBe(status);
    },
  );

  it.each([
    ["backlog", "running"],
    ["todo", "running"],
    ["ready", "running"],
    ["triage", "triage"],
    ["scheduled", "scheduled"],
    ["review", "review"],
    ["blocked", "blocked"],
    ["done", "done"],
  ] as const)("applies the running source-status guard from %s", async (status, expected) => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = `agent:main:dashboard:${status}`;
    const card = await createLinkedCard(store, { status, sessionKey });

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    expect((await store.get(card.id))?.status).toBe(expected);
  });

  it.each([
    ["running", "review"],
    ["todo", "review"],
    ["ready", "review"],
    ["triage", "triage"],
    ["backlog", "backlog"],
    ["scheduled", "scheduled"],
    ["blocked", "blocked"],
    ["done", "done"],
  ] as const)("applies the terminal source-status guard from %s", async (status, expected) => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = `agent:main:dashboard:terminal-${status}`;
    const card = await createLinkedCard(store, { status, sessionKey });

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
    });

    expect((await store.get(card.id))?.status).toBe(expected);
  });

  it("does not apply a terminal status older than the latest manual move", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:dashboard:manual-newer";
    const card = await createLinkedCard(store, { status: "running", sessionKey });

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: 2000, outcome: "ok" },
      now: 4000,
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it.each([
    {
      name: "session key",
      prepare: async (store: WorkboardStore) => {
        const sessionKey = "agent:main:dashboard:linked";
        const card = await createLinkedCard(store, { sessionKey });
        return { card, sessionKey, runId: "unrelated" };
      },
    },
    {
      name: "run id",
      prepare: async (store: WorkboardStore) => {
        const card = await createLinkedCard(store, { runId: "run-linked" });
        return { card, sessionKey: "agent:main:dashboard:other", runId: "run-linked" };
      },
    },
    {
      name: "dispatcher session key",
      prepare: async (store: WorkboardStore) => {
        const card = await createLinkedCard(store, { agentId: "worker", boardId: "ops" });
        return { card, sessionKey: workboardSessionKeyForCard(card), runId: "unrelated" };
      },
    },
  ])("matches cards by $name", async ({ prepare }) => {
    const store = new WorkboardStore(createMemoryStore());
    const { card, sessionKey, runId } = await prepare(store);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, runId, endedAt: card.updatedAt + 1, outcome: "ok" },
    });

    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("does not let a stale dispatcher event override an explicit session link", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createLinkedCard(store, {
      sessionKey: "agent:main:dashboard:replacement",
      agentId: "worker",
      boardId: "ops",
    });

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: workboardSessionKeyForCard(card),
        endedAt: card.updatedAt + 1,
        outcome: "ok",
      },
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("uses agent_end context to reconcile non-subagent linked sessions", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:dashboard:agent-end";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { sessionKey },
      now: card.updatedAt + 1,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
    });
  });

  it("marks an inactive running session stale and clears it after recovery", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:dashboard:stale";
    const card = await createLinkedCard(store, { status: "todo", sessionKey });
    const staleUpdatedAt = card.updatedAt + 1;
    const now = staleUpdatedAt + 31 * 60 * 1000;

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: false, updatedAt: staleUpdatedAt },
      ],
      complete: true,
      now,
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: {
        lifecycleStatusSourceUpdatedAt: staleUpdatedAt,
        stale: { lastSessionUpdatedAt: staleUpdatedAt },
      },
    });

    await runSessionSweep({
      store,
      sessions: [{ key: sessionKey, status: "running", hasActiveRun: true, updatedAt: now + 1 }],
      complete: true,
      now: now + 1,
    });

    expect((await store.get(card.id))?.metadata?.stale).toBeUndefined();
  });

  it("skips session discovery for an empty board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const readSessions = vi.fn().mockResolvedValue({ sessions: [], complete: true });
    const warn = vi.fn();
    const context = { logger: { warn } } as never;
    const service = createWorkboardLifecycleService({ store, readSessions });

    await service.start(context);
    service.onGatewayStart();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    service.onGatewayStop();
    await service.stop?.(context);

    expect(readSessions).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips session discovery when no unarchived card needs lifecycle reconciliation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({ title: "Not dispatched", status: "ready" });
    const archived = await createLinkedCard(store, {
      sessionKey: "agent:retired:subagent:workboard-default-archived",
    });
    await store.archive(archived.id, true);
    const readSessions = vi.fn().mockResolvedValue({ sessions: [], complete: true });
    const context = { logger: { warn: vi.fn() } } as never;
    const service = createWorkboardLifecycleService({ store, readSessions });

    await service.start(context);
    service.onGatewayStart();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    service.onGatewayStop();
    await service.stop?.(context);

    expect(readSessions).not.toHaveBeenCalled();
  });

  it("reconciles a captured unknown session when agent ownership is unambiguous", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createLinkedCard(store, { sessionKey: "unknown" });
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { selectionRequired: false };
      }
      return {
        sessions: [
          {
            key: "unknown",
            status: "done",
            hasActiveRun: false,
            updatedAt: card.updatedAt + 1,
          },
        ],
      };
    });
    const readSessions = vi.fn(
      async (options: { includeUnknown: boolean }) =>
        await readWorkboardLifecycleSessions({ isAvailable: async () => true, request }, options),
    );
    const context = { logger: { warn: vi.fn() } } as never;
    const service = createWorkboardLifecycleService({ store, readSessions });

    await service.start(context);
    service.onGatewayStart();
    await vi.waitFor(async () => expect((await store.get(card.id))?.status).toBe("review"));
    service.onGatewayStop();
    await service.stop?.(context);

    expect(readSessions).toHaveBeenCalledWith({ includeUnknown: true });
    expect(request).toHaveBeenNthCalledWith(1, "agents.list", {}, { scopes: ["operator.read"] });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.list",
      expect.objectContaining({ includeGlobal: false, includeUnknown: true }),
      { scopes: ["operator.read"] },
    );
  });

  it("reconciles an agent-prefixed Workboard session when discovery is relevant", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createLinkedCard(store, { agentId: "worker", boardId: "ops" });
    const sessionKey = workboardSessionKeyForCard(card);
    const suffix = sessionKey.slice(sessionKey.indexOf("subagent:workboard-"));

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
        {
          key: `agent:other:${suffix}`,
          status: "failed",
          hasActiveRun: false,
          updatedAt: card.updatedAt + 1,
        },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("does not suffix-match a uniquely wrong agent for an explicit target", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createLinkedCard(store, { agentId: "worker", boardId: "ops" });
    const sessionKey = workboardSessionKeyForCard(card);
    const suffix = sessionKey.slice(sessionKey.indexOf("subagent:workboard-"));

    await runSessionSweep({
      store,
      sessions: [
        {
          key: `agent:other:${suffix}`,
          status: "done",
          hasActiveRun: false,
          updatedAt: card.updatedAt + 1,
        },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("suffix-matches an accepted agentless run whose link could not be persisted", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Accepted without link", status: "ready" });
    const acceptedSessionKey = workboardSessionKeyForCard(card);
    const claimed = await store.claim(card.id, { ownerId: "workboard-dispatcher" });

    expect(claimed.card).toMatchObject({
      status: "running",
      agentId: "workboard-dispatcher",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
    await runSessionSweep({
      store,
      sessions: [
        {
          key: `agent:worker:${acceptedSessionKey}`,
          status: "done",
          hasActiveRun: false,
          updatedAt: claimed.card.updatedAt + 1,
        },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("does not suffix-match an agentless card when configured-agent sessions are ambiguous", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Ambiguous accepted run", status: "ready" });
    const acceptedSessionKey = workboardSessionKeyForCard(card);
    const claimed = await store.claim(card.id, { ownerId: "workboard-dispatcher" });

    await runSessionSweep({
      store,
      sessions: [
        {
          key: `agent:alpha:${acceptedSessionKey}`,
          status: "done",
          updatedAt: claimed.card.updatedAt + 1,
        },
        {
          key: `agent:beta:${acceptedSessionKey}`,
          status: "failed",
          updatedAt: claimed.card.updatedAt + 1,
        },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("suffix-matches an agentless linked card to an agent-prefixed Workboard session", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createLinkedCard(store, { boardId: "ops" });
    const sessionKey = `agent:worker:${workboardSessionKeyForCard(card)}`;

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("waits for gateway startup before beginning the lifecycle sweep", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:dashboard:startup-ready";
    const card = await createLinkedCard(store, { status: "todo", sessionKey });
    let gatewayReady = false;
    const readSessions = vi.fn(async () => {
      if (!gatewayReady) {
        throw new Error("sessions.list unavailable during gateway startup");
      }
      return {
        sessions: [{ key: sessionKey, status: "done" as const, updatedAt: card.updatedAt + 1 }],
        complete: true,
      };
    });
    const warn = vi.fn();
    const service = createWorkboardLifecycleService({ store, readSessions });
    const context = { logger: { warn } } as never;

    await service.start(context);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(readSessions).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    gatewayReady = true;
    service.onGatewayStart();
    await vi.waitFor(async () => expect((await store.get(card.id))?.status).toBe("review"));
    service.onGatewayStop();
    await service.stop?.(context);

    expect(readSessions).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs the bounded session reconciliation from the lifecycle-owned service interval", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:dashboard:service";
    const card = await createLinkedCard(store, { status: "todo", sessionKey });
    const readSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
        ],
        complete: true,
      })
      .mockResolvedValueOnce({
        sessions: [
          { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: card.updatedAt + 2 },
        ],
        complete: true,
      });
    const service = createWorkboardLifecycleService({ store, readSessions });
    await service.start({ logger: { warn: vi.fn() } } as never);
    service.onGatewayStart();
    await vi.waitFor(async () => {
      expect((await store.get(card.id))?.status).toBe("running");
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      expect((await store.get(card.id))?.status).toBe("review");
    });
    service.onGatewayStop();
    await service.stop?.({ logger: { warn: vi.fn() } } as never);

    expect(readSessions).toHaveBeenCalledTimes(2);
  });

  it("federates configured agents without ownerless sentinels", async () => {
    const request = vi
      .fn()
      .mockImplementation(
        async (_method: string, options: { includeGlobal?: boolean; includeUnknown?: boolean }) => {
          if (options.includeGlobal || options.includeUnknown) {
            throw new Error(
              'Multiple agents are configured, but session key "global" has no explicit owner.',
            );
          }
          return {
            sessions: [
              {
                key: "agent:alpha:dashboard:live",
                status: "running",
                hasActiveRun: false,
                updatedAt: 1234,
              },
            ],
          };
        },
      );

    await expect(
      readWorkboardLifecycleSessions({ isAvailable: async () => true, request }),
    ).resolves.toEqual({
      sessions: [
        {
          key: "agent:alpha:dashboard:live",
          status: "running",
          hasActiveRun: false,
          updatedAt: 1234,
        },
      ],
      complete: true,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      {
        limit: 10_000,
        configuredAgentsOnly: true,
        includeGlobal: false,
        includeUnknown: false,
      },
      { scopes: ["operator.read"] },
    );
  });

  it("keeps unknown excluded when explicit ownership requires agent selection", async () => {
    const request = vi.fn().mockImplementation(async (method: string, options: object) => {
      if (method === "agents.list") {
        return { selectionRequired: true };
      }
      expect(method).toBe("sessions.list");
      expect(options).toMatchObject({ includeGlobal: false, includeUnknown: false });
      return { sessions: [] };
    });

    await expect(
      readWorkboardLifecycleSessions(
        { isAvailable: async () => true, request },
        { includeUnknown: true },
      ),
    ).resolves.toEqual({ sessions: [], complete: true });
  });

  it("returns an incomplete empty snapshot without requesting while Gateway is unavailable", async () => {
    const request = vi.fn();

    await expect(
      readWorkboardLifecycleSessions({ isAvailable: async () => false, request }),
    ).resolves.toEqual({ sessions: [], complete: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a full sessions.list page as possibly truncated", async () => {
    // Keep a full page conservative even when a mock or older peer omits pagination
    // metadata, or absent sessions could be marked missing.
    const request = vi.fn().mockResolvedValue({
      sessions: Array.from({ length: 10_000 }, (_, index) => ({
        key: `agent:main:dashboard:${index}`,
        status: "done",
      })),
    });

    const snapshot = await readWorkboardLifecycleSessions({
      isAvailable: async () => true,
      request,
    });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.sessions).toHaveLength(10_000);
  });
});
