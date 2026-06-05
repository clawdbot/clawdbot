// Workboard tests cover gateway plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
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

describe("workboard gateway methods", () => {
  it("registers CRUD methods with read/write scopes", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.create",
      "workboard.cards.update",
      "workboard.cards.move",
      "workboard.cards.delete",
      "workboard.cards.comment",
      "workboard.cards.link",
      "workboard.cards.linkDependency",
      "workboard.cards.proof",
      "workboard.cards.artifact",
      "workboard.cards.claim",
      "workboard.cards.heartbeat",
      "workboard.cards.release",
      "workboard.cards.promote",
      "workboard.cards.reassign",
      "workboard.cards.reclaim",
      "workboard.cards.complete",
      "workboard.cards.block",
      "workboard.cards.unblock",
      "workboard.cards.bulk",
      "workboard.cards.diagnostics",
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.dispatch",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.boards.archive",
      "workboard.boards.delete",
      "workboard.cards.stats",
      "workboard.cards.runs",
      "workboard.cards.specify",
      "workboard.cards.decompose",
      "workboard.notifications.subscribe",
      "workboard.notifications.list",
      "workboard.notifications.delete",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.attachments.list",
      "workboard.cards.attachments.get",
      "workboard.cards.attachments.add",
      "workboard.cards.attachments.delete",
      "workboard.cards.workerLog",
      "workboard.cards.protocolViolation",
      "workboard.cards.archive",
      "workboard.cards.export",
    ]);
    expect(methods.get("workboard.cards.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics.refresh")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.export")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.create")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.cards.runs")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.attachments.get")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.cards.attachments.add")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.boards.upsert")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.notifications.list")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.events")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.advance")?.opts).toEqual({
      scope: "operator.write",
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
    });

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("stores metadata updates through dedicated card methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Carry metadata" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const commentRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "Waiting on CI" },
      respond: commentRespond,
    } as never);

    expect(commentRespond.mock.calls[0]?.[0]).toBe(true);
    expect(commentRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        metadata: {
          comments: [expect.objectContaining({ body: "Waiting on CI" })],
        },
        events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
      },
    });
  });

  it("validates labels from comma-separated gateway input", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const respond = vi.fn();
    await createHandler?.({
      params: { title: "Check labels", labels: `valid, ${"x".repeat(41)}` },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Claim me" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const claimRespond = vi.fn();
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: claimRespond,
    } as never);
    expect(claimRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = vi.fn();
    await methods.get("workboard.cards.heartbeat")?.handler({
      params: { id: cardId, ownerId: "main", note: "alive" },
      respond: heartbeatRespond,
    } as never);
    expect(heartbeatRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [cardId], patch: { priority: "urgent" } },
      respond: bulkRespond,
    } as never);
    expect(bulkRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = vi.fn();
    await methods.get("workboard.cards.complete")?.handler({
      params: { id: cardId, summary: "Operator closed it." },
      respond: completeRespond,
    } as never);
    expect(completeRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        status: "done",
        metadata: {
          comments: expect.arrayContaining([
            expect.objectContaining({ body: "Operator closed it." }),
          ]),
        },
      },
    });

    const blockedCreateRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Block me" },
      respond: blockedCreateRespond,
    } as never);
    const blockedCardId = blockedCreateRespond.mock.calls[0]?.[1]?.card.id;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: blockedCardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);
    const blockRespond = vi.fn();
    await methods.get("workboard.cards.block")?.handler({
      params: { id: blockedCardId, reason: "Operator blocked it." },
      respond: blockRespond,
    } as never);
    expect(blockRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "blocked" },
    });
  });
});
