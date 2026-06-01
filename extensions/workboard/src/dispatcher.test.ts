import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("dispatchAndStartWorkboardCards", () => {
  it("claims ready cards and starts bounded subagent worker runs", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First worker",
      status: "ready",
      priority: "urgent",
      agentId: "codex-main",
    });
    const second = await store.create({
      title: "Second worker",
      status: "ready",
      priority: "normal",
      agentId: "codex-main",
    });
    const otherAgent = await store.create({
      title: "Other worker",
      status: "ready",
      priority: "high",
      agentId: "codex-side",
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-first" })
      .mockResolvedValueOnce({ runId: "run-other" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started.map((entry) => entry.cardId).toSorted()).toEqual(
      [first.id, otherAgent.id].toSorted(),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      lane: `workboard:default:${first.id}`,
      deliver: false,
    });
    expect(run.mock.calls[0]?.[0]?.message).toContain("Claim token:");
    expect(run.mock.calls[0]?.[0]?.message).toContain("workboard_complete with the card id");
    expect(run.mock.calls[0]?.[0]?.message).not.toContain("ownerId and token");
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      runId: "run-first",
      execution: { status: "running", runId: "run-first" },
      metadata: {
        claim: { ownerId: "codex-main" },
        workerLogs: [expect.objectContaining({ message: expect.stringContaining("run-first") })],
      },
    });
    await expect(store.get(second.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { dispatchCount: 1 } },
    });
  });

  it("does not let review cards consume an agent running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Waiting for operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    const ready = await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: ready.id,
        runId: "run-next",
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps claimed review cards in the owner running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const review = await store.create({
      title: "Claimed operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    await store.claim(review.id, { ownerId: "codex-main", token: "review-token" });
    await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("blocks a card when worker start fails after claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Fail worker", status: "ready" });
    const run = vi.fn().mockRejectedValue(new Error("model unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: card.id, error: "model unavailable" }),
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("Dispatcher could not start worker"),
          }),
        ],
      },
    });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
  });
});
