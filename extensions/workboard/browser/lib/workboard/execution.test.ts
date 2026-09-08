// @vitest-environment node
import "../../test/host.setup.ts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { waitForFast } from "../../test/wait-for.ts";
import { startWorkboardCard, stopWorkboardCard } from "./execution.ts";
import { loadWorkboard } from "./loading.ts";
import { getWorkboardState, stopWorkboardLifecycleRefresh } from "./runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTask,
  createWorkboardTestClient,
} from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

function createExecutionHarness(card: WorkboardCard) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  return { host, state };
}

describe("Workboard execution ownership", () => {
  it.each([
    { name: "ambiguous provisional owners", identity: "none", partial: false },
    { name: "a provisional owner on a partial page", identity: "none", partial: true },
    { name: "an agentless global requester", identity: "global", partial: false },
    { name: "an exact task ID", identity: "task", partial: false },
    { name: "an exact run ID", identity: "run", partial: false },
    { name: "a canonical requester session", identity: "session", partial: false },
  ] as const)("preserves task ownership for $name", async ({ identity, partial }) => {
    const provisionalKey = "subagent:workboard-default-card-1";
    const writerKey = `agent:writer:${provisionalKey}`;
    const card = createWorkboardCard({
      status: "running",
      agentId: "reassigned",
      sessionKey:
        identity === "session" ? writerKey : identity === "global" ? "global" : provisionalKey,
      ...(identity === "task" ? { taskId: "task-writer" } : {}),
      ...(identity === "run" ? { runId: "run-writer" } : {}),
    });
    const { host, state } = createExecutionHarness(card);
    // The execution agent is not the owner of the task's requester session.
    const tasks = ["writer", "reviewer"].map((agentId, index) =>
      createWorkboardTask({
        id: `task-${agentId}`,
        taskId: `task-${agentId}`,
        agentId: "executor",
        sessionKey: identity === "global" ? "global" : `agent:${agentId}:${provisionalKey}`,
        childSessionKey: `agent:executor:child-${agentId}`,
        runId: `run-${agentId}`,
        updatedAt: index + 2,
      }),
    );
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [card] };
      }
      if (method === "tasks.list") {
        return partial ? { tasks: tasks.slice(0, 1), nextCursor: "next-page" } : { tasks };
      }
      if (method === "tasks.cancel") {
        return { found: true, cancelled: true };
      }
      if (method === "chat.abort") {
        return { aborted: true };
      }
      if (method === "workboard.cards.update") {
        return { card: { ...card, status: "blocked", updatedAt: 4 } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    expect(
      await loadWorkboard({
        host,
        client,
        force: true,
        taskRefresh: partial ? "linked" : "all",
      }),
    ).toBe(true);
    const loadedCard = state.cards[0];
    if (!loadedCard) {
      throw new Error("Expected the loaded Workboard card");
    }
    await stopWorkboardCard({ host, client, card: loadedCard });

    const cancellations = client.request.mock.calls.filter(([method]) => method === "tasks.cancel");
    if (identity === "none" || identity === "global") {
      expect(cancellations).toEqual([]);
      expect(client.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
      expect(state.tasksByCardId.size).toBe(0);
      expect(state.cards).toEqual([card]);
      expect(state.error).toContain("Refresh this card's session details");
    } else {
      expect(cancellations).toEqual([
        ["tasks.cancel", { taskId: "task-writer", reason: "Stopped from Workboard." }],
      ]);
      expect(state.cards[0]?.status).toBe("blocked");
      expect(state.error).toBeNull();
    }
  });

  it.each(["manual", "autonomous"] as const)(
    "requires explicitly unlinking a card before starting a %s execution",
    async (mode) => {
      const card = createWorkboardCard({ sessionKey: "agent:writer:existing" });
      const { host, state } = createExecutionHarness(card);
      const client = createWorkboardTestClient(() => {
        throw new Error("An existing link must not start a replacement execution");
      });

      const key = await startWorkboardCard({ host, client, card, mode });

      expect(client.request).not.toHaveBeenCalled();
      expect(key).toBeNull();
      expect(state.cards).toEqual([card]);
      expect(state.error).toBeTruthy();
    },
  );

  it("does not overwrite a link changed while a manual session is being created", async () => {
    const card = createWorkboardCard({ updatedAt: 12 });
    const { host, state } = createExecutionHarness(card);
    const created = createDeferred<{ key: string }>();
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return created.promise;
      }
      if (method === "workboard.cards.update") {
        return { card: { ...card, sessionKey: "agent:main:new" } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const start = startWorkboardCard({ host, client, card, mode: "manual" });
    await waitForFast(() => expect(client.request).toHaveBeenCalledOnce());
    const successor = { ...card, updatedAt: 13, sessionKey: "agent:writer:chosen" };
    state.cards = [successor];
    created.resolve({ key: "agent:main:new" });

    expect(await start).toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(state.cards).toEqual([successor]);
    expect(state.error).toBeTruthy();
    expect(state.busyCardIds.size).toBe(0);
  });

  it.each(["subagent:workboard-default-card-1", "global", "unknown"])(
    "does not guess an abort owner from an unresolved %s link",
    async (sessionKey) => {
      const card = createWorkboardCard({
        status: "running",
        agentId: "main",
        sessionKey,
        runId: "run-writer",
      });
      const { host, state } = createExecutionHarness(card);
      const client = createWorkboardTestClient(() => {
        throw new Error("A provisional key is not an abort target");
      });

      await stopWorkboardCard({ host, client, card });

      expect(client.request).not.toHaveBeenCalled();
      expect(state.cards).toEqual([card]);
      expect(state.error).toBeTruthy();
    },
  );

  it.each(["cancelled", "missing"] as const)(
    "handles a %s task without guessing the provisional session owner",
    async (outcome) => {
      const card = createWorkboardCard({
        status: "running",
        taskId: "task-writer",
        sessionKey: "subagent:workboard-default-card-1",
      });
      const { host, state } = createExecutionHarness(card);
      const task = createWorkboardTask({ id: "task-writer", taskId: "task-writer" });
      state.tasksByCardId.set(card.id, task);
      const cancelled = { ...task, status: "cancelled", updatedAt: 3 };
      const blocked = { ...card, status: "blocked", updatedAt: 4 };
      const client = createWorkboardTestClient((method) => {
        if (method === "tasks.cancel") {
          return outcome === "cancelled"
            ? { found: true, cancelled: true, task: cancelled }
            : { found: false, cancelled: false };
        }
        if (method === "workboard.cards.update") {
          return { card: blocked };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      await stopWorkboardCard({ host, client, card });

      expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
        taskId: "task-writer",
        reason: "Stopped from Workboard.",
      });
      expect(client.request.mock.calls.map(([method]) => method)).toEqual(
        outcome === "cancelled" ? ["tasks.cancel", "workboard.cards.update"] : ["tasks.cancel"],
      );
      if (outcome === "cancelled") {
        expect(state.cards).toEqual([blocked]);
        expect(state.tasksByCardId.get(card.id)?.status).toBe("cancelled");
        expect(state.error).toBeNull();
      } else {
        expect(state.cards).toEqual([card]);
        expect(state.missingTaskIds.has(task.taskId)).toBe(true);
        expect(state.error).toBeTruthy();
      }
    },
  );

  it("does not abort or replace a successor card after awaited task cancellation", async () => {
    const card = createWorkboardCard({
      status: "running",
      sessionKey: "agent:writer:original",
      taskId: "task-original",
      updatedAt: 10,
    });
    const { host, state } = createExecutionHarness(card);
    const task = createWorkboardTask({ id: "task-original", taskId: "task-original" });
    state.tasksByCardId.set(card.id, task);
    const cancelled = createDeferred<{
      found: boolean;
      cancelled: boolean;
      task: typeof task;
    }>();
    const client = createWorkboardTestClient((method) => {
      if (method === "tasks.cancel") {
        return cancelled.promise;
      }
      if (method === "chat.abort") {
        return { aborted: true };
      }
      if (method === "workboard.cards.update") {
        return { card: { ...card, status: "blocked", updatedAt: 12 } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const stop = stopWorkboardCard({ host, client, card });
    await waitForFast(() => expect(client.request).toHaveBeenCalledOnce());
    const successor = {
      ...card,
      updatedAt: 11,
      sessionKey: "agent:writer:replacement",
      taskId: "task-replacement",
    };
    const successorTask = createWorkboardTask({
      id: "task-replacement",
      taskId: "task-replacement",
    });
    state.cards = [successor];
    state.tasksByCardId.set(card.id, successorTask);
    cancelled.resolve({ found: true, cancelled: true, task: { ...task, status: "cancelled" } });
    await stop;

    expect(client.request).toHaveBeenCalledOnce();
    expect(state.cards).toEqual([successor]);
    expect(state.tasksByCardId.get(card.id)).toEqual(successorTask);
    expect(state.error).toBeTruthy();
    expect(state.busyCardIds.size).toBe(0);
  });

  it.each(["start", "stop"] as const)(
    "finishes an admitted %s after page hiding without reopening mutation admission",
    async (action) => {
      const key = "agent:writer:manual";
      const card = createWorkboardCard({
        updatedAt: 17,
        ...(action === "stop" ? { sessionKey: key, status: "running" } : {}),
      });
      const { host, state } = createExecutionHarness(card);
      const updated = createWorkboardCard({
        ...card,
        sessionKey: key,
        status: action === "stop" ? "blocked" : card.status,
        updatedAt: 18,
      });
      const preparation = createDeferred<unknown>();
      const client = createWorkboardTestClient((method) => {
        if (method === "sessions.create" || method === "chat.abort") {
          return preparation.promise;
        }
        if (method === "workboard.cards.update") {
          return { card: updated };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      const operation =
        action === "start"
          ? startWorkboardCard({ host, client, card, mode: "manual" })
          : stopWorkboardCard({ host, client, card });
      await waitForFast(() => expect(client.request).toHaveBeenCalledOnce());
      stopWorkboardLifecycleRefresh(host);
      preparation.resolve(action === "start" ? { key } : { aborted: true });
      await operation;

      expect(client.request).toHaveBeenCalledWith(
        "workboard.cards.update",
        expect.objectContaining({ id: card.id, expectedUpdatedAt: 17 }),
      );
      expect(state.cards).toEqual([updated]);
      expect(state.error).toBeNull();
      expect(state.loaded).toBe(false);
      expect(state.mutationReadiness).toBe("canonical_reload_required");
    },
  );
});
