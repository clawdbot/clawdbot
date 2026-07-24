// Workboard tests cover gateway plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

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
      "workboard.cards.proof.list",
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
      "workboard.cards.dispatchWithOptions",
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
    expect(methods.get("workboard.cards.proof.list")?.opts).toEqual({ scope: "operator.read" });
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
    expect(createRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
      proofPage: { total: 0, hasMore: false },
    });

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [
        expect.objectContaining({
          title: "Investigate queue drift",
          proofPage: { total: 0, hasMore: false },
        }),
      ],
      boards: [expect.objectContaining({ id: "default", total: 1, active: 1 })],
    });

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("projects representative card-bearing responses while proof pages and export remain complete", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const api = {
      runtime: {},
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const proof = Array.from({ length: 100 }, (_, index) => ({
      id: `proof-${index}`,
      status: "passed" as const,
      createdAt: index + 1,
      label: `Proof ${index}`,
    }));
    const card = await store.create({ title: "Gateway projection", metadata: { proof } });
    await keyed.register("diagnostic-card", {
      version: 1,
      card: {
        id: "diagnostic-card",
        title: "Diagnostic projection",
        status: "ready",
        priority: "normal",
        labels: [],
        agentId: "worker",
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { proof },
      },
    });
    registerWorkboardGatewayMethods({ api, store });

    const invoke = async (method: string, params: Record<string, unknown> = {}) => {
      const respond = vi.fn();
      await methods.get(method)?.handler({ params, respond } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1] as Record<string, unknown>;
    };
    const expectView = (value: unknown, total: number) => {
      const view = value as {
        metadata?: { proof?: unknown[] };
        proofPage?: { total?: number; hasMore?: boolean };
      };
      expect(view.metadata?.proof).toHaveLength(40);
      expect(view.proofPage).toEqual(expect.objectContaining({ total, hasMore: total > 40 }));
    };

    const listed = await invoke("workboard.cards.list");
    const listedCards = listed.cards as Array<{ id: string }>;
    expectView(
      listedCards.find((entry) => entry.id === card.id),
      100,
    );

    const updated = await invoke("workboard.cards.update", {
      id: card.id,
      patch: { notes: "Updated" },
    });
    expectView(updated.card, 100);

    const bulk = await invoke("workboard.cards.bulk", {
      ids: [card.id],
      patch: { priority: "high" },
    });
    expectView((bulk.cards as unknown[])[0], 100);

    const runs = await invoke("workboard.cards.runs", { id: card.id });
    expectView(runs.card, 100);

    const attachments = await invoke("workboard.cards.attachments.list", { id: card.id });
    expectView(attachments.card, 100);

    const diagnostics = await invoke("workboard.cards.diagnostics");
    const diagnosticRows = diagnostics.diagnostics as Array<{ card: unknown }>;
    expectView(
      diagnosticRows.find((row) => (row.card as { id?: string }).id === "diagnostic-card")?.card,
      100,
    );

    const added = await invoke("workboard.cards.proof", {
      id: card.id,
      status: "passed",
      label: "Proof 100",
    });
    expect(added.proofId).toEqual(expect.any(String));
    expectView(added.card, 101);

    const page = await invoke("workboard.cards.proof.list", { id: card.id, limit: 10 });
    expect(page).toMatchObject({ total: 101, hasMore: true });
    expect(page.proof).toHaveLength(10);

    const exported = await invoke("workboard.cards.export");
    const exportedCard = (
      exported.cards as Array<{ id: string; metadata?: { proof?: unknown[] } }>
    ).find((entry) => entry.id === card.id);
    expect(exportedCard?.metadata?.proof).toHaveLength(101);
    expect(exportedCard).not.toHaveProperty("proofPage");
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        proof: expect.arrayContaining([expect.objectContaining({ label: "Proof 100" })]),
      },
    });
    expect((await store.get(card.id))?.metadata?.proof).toHaveLength(101);
  });

  it("applies connected client workspace access when accepting card paths", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const store = new WorkboardStore(createMemoryStore());
    const api = {
      runtime: {
        agent: {
          listAgentIds: vi.fn(() => ["main"]),
          resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    registerWorkboardGatewayMethods({ api, store });
    const create = methods.get("workboard.cards.create")?.handler;
    const context = {
      getRuntimeConfig: () => ({ agents: { defaults: { workspace: "/workspace" } } }),
    };

    const deniedRespond = vi.fn();
    await create?.({
      params: {
        title: "Outside",
        workspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: deniedRespond,
    } as never);
    expect(deniedRespond.mock.calls[0]?.[0]).toBe(false);
    expect(deniedRespond.mock.calls[0]?.[2]?.message).toContain("outside the caller");

    const insideRespond = vi.fn();
    await create?.({
      params: {
        title: "Inside",
        workspace: { kind: "worktree", sourcePath: "/workspace/repo" },
        workspaceAccess: { unrestricted: true },
        metadata: { automation: { workspaceAccess: { unrestricted: true } } },
      },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: insideRespond,
    } as never);
    expect(insideRespond.mock.calls[0]?.[0]).toBe(true);
    expect(insideRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
    const insideId = insideRespond.mock.calls[0]?.[1]?.card.id as string;
    const forgedUpdateRespond = vi.fn();
    await methods.get("workboard.cards.update")?.handler({
      params: { id: insideId, patch: { workspaceAccess: { unrestricted: true } } },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: forgedUpdateRespond,
    } as never);
    expect(forgedUpdateRespond.mock.calls[0]?.[0]).toBe(true);
    const forgedBulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [insideId], patch: { workspaceAccess: { unrestricted: true } } },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: forgedBulkRespond,
    } as never);
    expect(forgedBulkRespond.mock.calls[0]?.[0]).toBe(true);
    await expect(store.get(insideId)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });

    const adminRespond = vi.fn();
    await create?.({
      params: {
        title: "Admin outside",
        workspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      client: { connect: { scopes: ["operator.admin"] } },
      respond: adminRespond,
    } as never);
    expect(adminRespond.mock.calls[0]?.[0]).toBe(true);
    expect(adminRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await methods.get("workboard.boards.upsert")?.handler({
      params: {
        id: "outside-default",
        defaultWorkspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      client: { connect: { scopes: ["operator.admin"] } },
      respond: vi.fn(),
    } as never);
    const inheritedRespond = vi.fn();
    await create?.({
      params: { title: "No implicit workspace", boardId: "outside-default" },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: inheritedRespond,
    } as never);
    expect(inheritedRespond.mock.calls[0]?.[0]).toBe(true);
    expect(
      inheritedRespond.mock.calls[0]?.[1]?.card.metadata?.automation?.workspace,
    ).toBeUndefined();
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

  it("dispatches workboard cards when gateway params are omitted", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
      workspaceAccess: { unrestricted: true },
    });

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({ respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ cardId: card.id, runId: "run-card" })],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
  });

  it("threads maxStarts while the legacy method keeps its default cap", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const api = {
      runtime: {
        state: { openKeyedStore: vi.fn(() => createMemoryStore()) },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.create({
          title: `Capped ${index}`,
          status: "ready",
          priority: "urgent",
          agentId: `capped-${index}`,
          boardId: "capped",
          workspaceAccess: { unrestricted: true },
        }),
      ),
    );
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatchWithOptions")?.handler;

    const respond = vi.fn();
    await handler?.({ params: { boardId: "capped", maxStarts: 4 }, respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]?.started).toHaveLength(4);
    expect(run).toHaveBeenCalledTimes(4);

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.create({
          title: `Legacy ${index}`,
          status: "ready",
          priority: "urgent",
          agentId: `legacy-${index}`,
          boardId: "legacy",
          workspaceAccess: { unrestricted: true },
        }),
      ),
    );
    const defaultRespond = vi.fn();
    await methods
      .get("workboard.cards.dispatch")
      ?.handler({ params: { boardId: "legacy" }, respond: defaultRespond } as never);
    expect(defaultRespond.mock.calls[0]?.[1]?.started).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(7);

    const legacyRespond = vi.fn();
    await methods
      .get("workboard.cards.dispatch")
      ?.handler({ params: { maxStarts: 1 }, respond: legacyRespond } as never);
    expect(legacyRespond.mock.calls[0]?.[0]).toBe(false);
    expect(legacyRespond.mock.calls[0]?.[2]?.message).toBe(
      "maxStarts requires workboard.cards.dispatchWithOptions.",
    );

    for (const value of [0, -1, 1.5, "2"]) {
      const invalidRespond = vi.fn();
      await handler?.({ params: { maxStarts: value }, respond: invalidRespond } as never);
      expect(invalidRespond.mock.calls[0]?.[0]).toBe(false);
      expect(invalidRespond.mock.calls[0]?.[2]?.message).toBe(
        "maxStarts must be a positive integer.",
      );
    }
  });

  it("keeps write-scope worktree dispatch within configured agent workspaces", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const createWorktree = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    const api = {
      runtime: {
        agent: {
          listAgentIds: vi.fn(() => ["main"]),
          resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
        },
        sandbox: {
          resolveWorkspaceAuthority: vi.fn(() => ({
            sandboxed: true,
            workspaceAccess: "rw",
          })),
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true,
            workspaceAccess: "rw",
          })),
        },
        subagent: { run },
        worktrees: {
          resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
          hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
          create: createWorktree,
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const denied = await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatch")?.handler;

    const deniedRespond = vi.fn();
    await handler?.({
      client: { connect: { scopes: ["operator.write"] } },
      context: {
        getRuntimeConfig: () => ({
          tools: { fs: { workspaceOnly: true } },
          agents: {
            defaults: {
              workspace: "/workspace",
              sandbox: { mode: "non-main", workspaceAccess: "rw" },
            },
          },
        }),
      },
      respond: deniedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(deniedRespond.mock.calls[0]?.[1]).toMatchObject({
      startFailures: [
        expect.objectContaining({
          cardId: denied.id,
          error: "workspace path is outside the caller's allowed workspaces.",
        }),
      ],
    });
    await expect(store.get(denied.id)).resolves.toMatchObject({ status: "ready" });
    await store.update(denied.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/workspace" },
    });
    const allowedRespond = vi.fn();
    await handler?.({
      client: { connect: { scopes: ["operator.write"] } },
      context: {
        getRuntimeConfig: () => ({
          tools: { fs: { workspaceOnly: true } },
          agents: {
            defaults: {
              workspace: "/workspace",
              sandbox: { mode: "non-main", workspaceAccess: "rw" },
            },
          },
        }),
      },
      respond: allowedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(allowedRespond.mock.calls[0]?.[1]).toMatchObject({ startFailures: [], started: [{}] });
    expect(api.runtime.sandbox.prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace",
        confinedToolNames: expect.arrayContaining(["workboard_complete"]),
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(allowed.id)).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/workspace" } } },
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
