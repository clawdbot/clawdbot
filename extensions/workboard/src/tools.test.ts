// Workboard tests cover tools plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

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

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard tools", () => {
  it("lists, claims, heartbeats, and reads worker context", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const workboardStore = new WorkboardStore(keyed);
    const tools = createWorkboardTools({
      api,
      store: workboardStore,
      context: { agentId: "main", sessionKey: "session-1" } as never,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const store = keyed;
    await store.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Ship coordination",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await store.register("archived-1", {
      version: 1,
      card: {
        id: "archived-1",
        title: "Closed work",
        status: "done",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    });

    const claimed = readPayload(
      await byName.get("workboard_claim")?.execute("call-1", { id: "card-1" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "main", token: "[redacted]" } },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "alive" })] },
    });

    const read = readPayload(
      await byName.get("workboard_read")?.execute("call-3", { id: "card-1" }),
    );
    expect(read.workerContext).toContain("Ship coordination");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });

    const released = readPayload(
      await byName
        .get("workboard_release")
        ?.execute("call-4", { id: "card-1", token, status: "review" }),
    );
    expect(released).toMatchObject({ status: "review" });
    expect((released.metadata as { claim?: unknown } | undefined)?.claim).toBeUndefined();

    const list = readPayload(await byName.get("workboard_list")?.execute("call-5", {}));
    expect(list.cards).toEqual([expect.objectContaining({ id: "card-1" })]);
    const archivedList = readPayload(
      await byName.get("workboard_list")?.execute("call-6", { includeArchived: true }),
    );
    expect(archivedList.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "archived-1", archivedAt: 2 })]),
    );
  });

  it("can share one store across tool instances for claim coordination", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Single owner" });

    await mainTools.get("workboard_claim")?.execute("call-1", { id: card.id });

    await expect(
      otherTools.get("workboard_claim")?.execute("call-2", { id: card.id }),
    ).rejects.toThrow(/already claimed/);
  });

  it("requires claim scope before creating or linking dependencies against claimed cards", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const parent = await store.create({ title: "Claimed parent" });
    const claimed = await store.claim(parent.id, { ownerId: "main", token: "parent-token" });

    await expect(
      otherTools.get("workboard_create")?.execute("call-1", {
        title: "Blocked child",
        parents: [parent.id],
      }),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      otherTools.get("workboard_create")?.execute("call-1b", {
        title: "Blocked child",
        parents: parent.id,
      }),
    ).rejects.toThrow(/claimed by main/);
    expect(await store.list()).toHaveLength(1);

    await otherTools.get("workboard_create")?.execute("call-2", {
      title: "Scoped child",
      parents: [parent.id],
      token: claimed.token,
    });
    const child = await store.create({ title: "Claimed child" });
    await store.claim(child.id, { ownerId: "main", token: "child-token" });
    await expect(
      otherTools.get("workboard_link")?.execute("call-3", {
        parentId: parent.id,
        childId: child.id,
      }),
    ).rejects.toThrow(/claimed by main/);

    const linked = readPayload(
      await otherTools.get("workboard_link")?.execute("call-4", {
        parentId: parent.id,
        childId: (await store.create({ title: "Idle child" })).id,
        token: claimed.token,
      }),
    );
    expect(linked.card).toMatchObject({ status: "todo" });

    await expect(
      mainTools.get("workboard_link")?.execute("call-5", {
        parentId: parent.id,
        childId: child.id,
        token: "child-token",
      }),
    ).rejects.toThrow(/active child/);
  });

  it("creates dependent cards and completes claimed work through tools", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const parentPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-1", {
        title: "Parent",
        status: "running",
      }),
    );
    const parent = parentPayload.card as { id: string };
    const childPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-2", {
        title: "Child",
        parents: [parent.id],
        tenant: "qa",
        skills: ["testing"],
      }),
    );
    const child = childPayload.card as { id: string; status: string };
    expect(child.status).toBe("todo");

    await expect(
      tools.get("workboard_complete")?.execute("call-unclaimed-complete", {
        id: parent.id,
        summary: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_block")?.execute("call-unclaimed-block", {
        id: child.id,
        reason: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_protocol_violation")?.execute("call-unclaimed-violation", {
        id: child.id,
        detail: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);

    const claimed = readPayload(
      await tools.get("workboard_claim")?.execute("call-3", { id: parent.id }),
    );
    const token = claimed.token as string;
    const completed = readPayload(
      await tools.get("workboard_complete")?.execute("call-4", {
        id: parent.id,
        token,
        summary: "Done.",
        createdCardIds: [child.id],
        proof: { status: "passed", command: "pnpm test extensions/workboard" },
      }),
    );
    expect(completed.card).toMatchObject({ status: "done" });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-5", {}));
    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
  });

  it("redacts claim tokens from dispatch tool results", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: 1,
    });
    await store.update(card.id, {
      metadata: {
        ...card.metadata,
        claim: {
          ownerId: "main",
          token: "secret-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-1", {}));

    const promoted = dispatch.promoted as Array<{
      metadata?: { claim?: { token?: string } };
    }>;
    expect(promoted).toEqual([expect.objectContaining({ id: card.id })]);
    expect(promoted[0]?.metadata?.claim?.token).toBe("[redacted]");
  });

  it("exposes board lifecycle, decomposition, runs, and notification tools", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const boardPayload = readPayload(
      await tools.get("workboard_board_create")?.execute("call-board", {
        id: "planning",
        name: "Planning",
        orchestration: {
          autoDecompose: true,
          autoDecomposePerDispatch: 2,
          orchestratorProfile: "planner",
        },
      }),
    );
    expect(boardPayload.board).toMatchObject({
      id: "planning",
      name: "Planning",
      orchestration: {
        autoDecompose: true,
        autoDecomposePerDispatch: 2,
        orchestratorProfile: "planner",
      },
    });

    const parent = await store.create({
      title: "Rough",
      status: "triage",
      boardId: "planning",
      idempotencyKey: "planning:rough",
    });
    const specified = readPayload(
      await tools.get("workboard_specify")?.execute("call-specify", {
        id: parent.id,
        title: "Specified",
        summary: "Ready to split.",
      }),
    );
    expect(specified.card).toMatchObject({ title: "Specified", status: "todo" });

    const decomposed = readPayload(
      await tools.get("workboard_decompose")?.execute("call-decompose", {
        id: parent.id,
        summary: "Split.",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );
    expect(decomposed.parent).toMatchObject({ status: "done" });
    expect(decomposed.children).toEqual([
      expect.objectContaining({ title: "Child A" }),
      expect.objectContaining({ title: "Child B" }),
    ]);

    const runs = readPayload(
      await tools.get("workboard_runs")?.execute("call-runs", { id: parent.id }),
    );
    expect(runs.attempts).toEqual([]);

    const subscription = readPayload(
      await tools.get("workboard_notify_subscribe")?.execute("call-subscribe", {
        boardId: "planning",
        cardId: parent.id,
        target: "session:operator",
        eventKinds: ["completed"],
      }),
    );
    expect(subscription.subscription).toMatchObject({
      boardId: "planning",
      cardId: parent.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const list = readPayload(
      await tools.get("workboard_notify_list")?.execute("call-notify-list", {
        boardId: "planning",
      }),
    );
    expect(list.subscriptions).toEqual([
      expect.objectContaining({ cardId: parent.id, target: "session:operator" }),
    ]);

    const events = readPayload(
      await tools.get("workboard_notify_advance")?.execute("call-notify-events", {
        subscriptionId: (subscription.subscription as { id: string }).id,
      }),
    );
    expect(events.events).toEqual([expect.objectContaining({ kind: "completed" })]);

    const attached = readPayload(
      await tools.get("workboard_attachment_add")?.execute("call-attach", {
        id: parent.id,
        fileName: "result.txt",
        contentBase64: Buffer.from("done").toString("base64"),
      }),
    );
    expect(attached.card).toMatchObject({
      metadata: { attachments: [expect.objectContaining({ fileName: "result.txt" })] },
    });
    const attachments = (attached.card as { metadata: { attachments: Array<{ id: string }> } })
      .metadata.attachments;
    const attachmentId = expectDefined(attachments[0], "workboard attachment").id;
    const attachment = readPayload(
      await tools.get("workboard_attachment_read")?.execute("call-attachment-read", {
        id: attachmentId,
      }),
    );
    expect(Buffer.from(attachment.contentBase64 as string, "base64").toString("utf8")).toBe("done");
  });
});
