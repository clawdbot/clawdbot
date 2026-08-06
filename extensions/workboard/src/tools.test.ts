// Workboard tests cover tools plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";
import { guardWorkboardToolsForWorkspaceAccess } from "./workspace-access.js";

const WORKBOARD_MODEL_OUTPUT_BYTES = 24 * 1024;

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
  it("inherits the active tool filesystem boundary for workspace metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    const restrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: true },
    } as const;
    const restricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context: restrictedContext }),
        restrictedContext,
      ).map((tool) => [tool.name, tool]),
    );

    await expect(
      restricted.get("workboard_create")?.execute("outside", {
        title: "Outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
    await expect(
      restricted.get("workboard_create")?.execute("inside", {
        title: "Inside",
        workspace: { kind: "worktree", path: "/workspace/repo" },
        workspaceAccess: { unrestricted: true },
      }),
    ).resolves.toBeDefined();

    const unrestrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
    } as const;
    const unrestricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context: unrestrictedContext }),
        unrestrictedContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      unrestricted.get("workboard_create")?.execute("unrestricted", {
        title: "Unrestricted",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).resolves.toBeDefined();

    expect((await store.list()).find((card) => card.title === "Inside")).toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
    expect((await store.list()).find((card) => card.title === "Unrestricted")).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    const sandboxContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
      sandboxed: true,
    } as const;
    const sandboxed = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context: sandboxContext }),
        sandboxContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      sandboxed.get("workboard_create")?.execute("sandbox-outside", {
        title: "Sandbox outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
  });

  it("preserves read-only sandbox authority while allowing manual card movement", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    const context: NonNullable<Parameters<typeof guardWorkboardToolsForWorkspaceAccess>[1]> = {
      agentId: "main",
      sessionKey: "agent:main:subagent:readonly",
      workspaceDir: "/workspace",
      sandboxed: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } },
          list: [{ id: "main", default: true, workspace: "/workspace" }],
        },
      },
    };
    const tools = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context }),
        context,
      ).map((tool) => [tool.name, tool]),
    );

    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-readonly", {
        title: "Read-only card",
      }),
    ).card as { id: string };
    await expect(
      tools.get("workboard_promote")?.execute("move-readonly", { id: created.id, force: true }),
    ).resolves.toBeDefined();
    await expect(store.get(created.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
        },
      },
    });
  });

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
      proofPage: { total: 0, hasMore: false },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "alive" })] },
      proofPage: { total: 0, hasMore: false },
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
    expect(released).toMatchObject({
      status: "review",
      proofPage: { total: 0, hasMore: false },
    });
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

  it("hard-bounds proof in model card results while persistence stays canonical", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const proof = Array.from({ length: 100 }, (_, index) => ({
      id: `proof-${index}`,
      status: "passed" as const,
      createdAt: index + 1,
      label: `Proof ${index}`,
      note: "🧪".repeat(1000),
    }));
    const card = await store.create({ title: "Tool projection", metadata: { proof } });
    const tools = new Map(
      createWorkboardTools({
        api: { runtime: {} } as unknown as OpenClawPluginApi,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const readParameters = tools.get("workboard_read")?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(readParameters?.properties).toHaveProperty("proofView");

    const read = readPayload(await tools.get("workboard_read")?.execute("read", { id: card.id }));
    const embeddedProof =
      (read.card as { metadata?: { proof?: Array<{ id: string }> } }).metadata?.proof ?? [];
    expect(embeddedProof.length).toBeGreaterThan(0);
    expect(embeddedProof.length).toBeLessThan(40);
    expect(embeddedProof.at(-1)?.id).toBe("proof-99");
    expect(Buffer.byteLength(JSON.stringify(read.card), "utf8")).toBeLessThanOrEqual(
      WORKBOARD_MODEL_OUTPUT_BYTES,
    );
    expect(read.card).toMatchObject({
      proofPage: {
        total: 100,
        hasMore: true,
        nextCursor: expect.any(String),
      },
    });
    const explicitBoundedRead = readPayload(
      await tools
        .get("workboard_read")
        ?.execute("read-explicit-bounded", { id: card.id, proofView: "bounded" }),
    );
    expect(explicitBoundedRead.card).toMatchObject({
      proofPage: { total: 100, hasMore: true },
    });
    const olderCursor = (read.card as { proofPage: { nextCursor?: string } }).proofPage.nextCursor;
    const oldestEmbeddedId = expectDefined(embeddedProof[0], "oldest embedded Workboard proof").id;

    const commented = readPayload(
      await tools.get("workboard_comment")?.execute("comment", {
        id: card.id,
        body: "Keep proof canonical.",
      }),
    );
    const commentedProof = (commented.metadata as { proof?: unknown[] }).proof ?? [];
    expect(commented).toMatchObject({ proofPage: { total: 100, hasMore: true } });
    expect(commentedProof.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(commented), "utf8")).toBeLessThanOrEqual(
      WORKBOARD_MODEL_OUTPUT_BYTES,
    );

    const added = readPayload(
      await tools.get("workboard_proof")?.execute("proof", {
        id: card.id,
        status: "passed",
        label: "Proof 100",
      }),
    );
    expect(added.proofId).toEqual(expect.any(String));
    const addedCard = added.card as {
      metadata?: { proof?: unknown[] };
      proofPage: { total: number; hasMore: boolean };
    };
    const addedProof = addedCard.metadata?.proof ?? [];
    expect(addedCard.proofPage).toMatchObject({ total: 101, hasMore: true });
    expect(addedProof.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(addedCard), "utf8")).toBeLessThanOrEqual(
      WORKBOARD_MODEL_OUTPUT_BYTES,
    );

    const olderResult = await tools.get("workboard_proof_list")?.execute("proof-list-older", {
      id: card.id,
      limit: 40,
      cursor: olderCursor,
    });
    const older = readPayload(olderResult);
    const olderProof = older.proof as Array<{ id: string }>;
    expect(older).toMatchObject({ total: 101, hasMore: true });
    expect(olderProof.length).toBeGreaterThan(0);
    expect(olderProof.length).toBeLessThan(40);
    const olderText =
      (olderResult as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    expect(Buffer.byteLength(olderText, "utf8")).toBeLessThanOrEqual(WORKBOARD_MODEL_OUTPUT_BYTES);
    expect(olderProof).not.toContainEqual(expect.objectContaining({ id: oldestEmbeddedId }));
    const newestOlderId = expectDefined(olderProof.at(-1), "newest older Workboard proof").id;
    expect(Number(newestOlderId.split("-")[1])).toBe(Number(oldestEmbeddedId.split("-")[1]) - 1);

    const canonical = await store.get(card.id);
    expect(canonical?.metadata?.proof).toHaveLength(101);
    expect(canonical).not.toHaveProperty("proofPage");
  });

  it("keeps default sqlite tool reads off canonical proof hydration", async () => {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-tool-bounded-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({
        title: "Bounded SQLite tool",
        metadata: {
          proof: Array.from({ length: 100 }, (_, index) => ({
            id: `proof-${index}`,
            status: "passed" as const,
            createdAt: index + 1,
            label: `Proof ${index}`,
          })),
        },
      });
      const tools = new Map(
        createWorkboardTools({
          api: { runtime: {} } as unknown as OpenClawPluginApi,
          store,
          context: { agentId: "main" } as never,
        }).map((tool) => [tool.name, tool]),
      );

      stores.cards.lookup = async () => {
        throw new Error("canonical lookup must not back bounded tool reads");
      };
      stores.cards.entries = async () => {
        throw new Error("canonical entries must not back bounded tool reads");
      };

      const result = readPayload(
        await tools.get("workboard_read")?.execute("sqlite-bounded", { id: card.id }),
      );
      expect(result.card).toMatchObject({ proofPage: { total: 100, hasMore: true } });
      expect(result.workerContext).toContain("Proof 99");
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

    await expect(
      otherTools.get("workboard_create")?.execute("call-2b", {
        title: "Wrong token child",
        parents: [parent.id],
        token: "test-token-placeholder",
      }),
    ).rejects.toThrow(/claimed by main/);
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
    const pendingProof = readPayload(
      await tools.get("workboard_proof")?.execute("call-proof", {
        id: parent.id,
        token,
        command: "pnpm test extensions/workboard",
      }),
    );
    expect(pendingProof.proofId).toEqual(expect.any(String));
    const completed = readPayload(
      await tools.get("workboard_complete")?.execute("call-4", {
        id: parent.id,
        token,
        summary: "Done.",
        createdCardIds: [child.id],
        proofId: pendingProof.proofId,
        proof: { status: "passed", command: "pnpm test extensions/workboard" },
      }),
    );
    expect(completed.card).toMatchObject({
      status: "done",
      metadata: { proof: [{ id: pendingProof.proofId, status: "passed" }] },
    });

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
    expect(decomposed.parent).toMatchObject({
      status: "done",
      proofPage: { total: 0, hasMore: false },
    });
    expect(decomposed.children).toEqual([
      expect.objectContaining({
        title: "Child A",
        proofPage: { total: 0, hasMore: false },
      }),
      expect.objectContaining({
        title: "Child B",
        proofPage: { total: 0, hasMore: false },
      }),
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

  it("moves cards with agent claim scope", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    const tools = new Map(
      createWorkboardTools({ api, store, context: { agentId: "agent-b" } as never }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const card = await store.create({ title: "Move tool card", status: "todo" });

    const unclaimed = readPayload(
      await tools.get("workboard_move")?.execute("move-unclaimed", {
        id: card.id,
        status: "ready",
      }),
    );
    expect(unclaimed.card).toMatchObject({
      status: "ready",
      proofPage: { total: 0, hasMore: false },
    });

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      tools.get("workboard_move")?.execute("move-denied", {
        id: card.id,
        status: "review",
      }),
    ).rejects.toThrow("card is claimed by agent-a");

    const claimed = readPayload(
      await tools.get("workboard_move")?.execute("move-claimed", {
        id: card.id,
        status: "review",
        token: "test-auth-token",
      }),
    );
    expect(claimed.card).toMatchObject({ status: "review" });
  });
});
