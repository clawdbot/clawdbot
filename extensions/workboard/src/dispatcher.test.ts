// Workboard tests cover dispatcher plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { cleanupWorkboardRunWorktree } from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
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

describe("dispatchAndStartWorkboardCards", () => {
  it("materializes managed worktrees, supplies cwd, persists them, and cleans up on run end", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Isolated worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-worktree" });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({
        id: "managed-id",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: `openclaw/wb-${card.id}`,
      }),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: {
        now: 10,
        maxStarts: 1,
        materializeWorktree: true,
      },
    });

    expect(worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        baseRef: "main",
        ownerKind: "workboard",
        ownerId: card.id,
      }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/state/worktrees/fingerprint/wb-card" }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspace: {
            kind: "worktree",
            path: "/state/worktrees/fingerprint/wb-card",
            branch: `openclaw/wb-${card.id}`,
            sourcePath: "/repo",
            sourceBranch: "main",
          },
        },
      },
    });

    await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-worktree" });
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/fingerprint/wb-card",
      ownerKind: "workboard",
      ownerId: card.id,
    });
  });

  it("requires explicit reauthorization for legacy cards under full-host dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Legacy worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const run = vi.fn();
    const create = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo"),
        create,
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: { maxStarts: 1, materializeWorktree: true },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error:
          "card workspace authority is unknown; re-save its workspace with current permissions before dispatch.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.metadata?.automation?.workspaceAccess).toBeUndefined();
  });

  it("adopts current authority for a legacy card without a host workspace path", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Legacy scratch worker", status: "ready" });
    const run = vi.fn().mockResolvedValue({ runId: "run-legacy-scratch" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    expect((await store.get(card.id))?.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: true,
    });
  });

  it("does not claim a card whose workspace authority changed after preflight", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Racing authority update",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace" },
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, input, options) => {
      await store.update(id, {
        workspaceAccess: {
          unrestricted: false,
          roots: ["/workspace"],
          writable: true,
        },
      });
      return await originalClaim(id, input, options);
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "card workspace authority changed before claim.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects worktree sources outside the dispatcher's workspace boundary", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protected checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      worktrees,
      options: {
        maxStarts: 1,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path is outside the caller's allowed workspaces.",
      }),
    ]);
    expect(worktrees.create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    expect((await store.get(card.id))?.metadata?.automation?.workspaceAccess).toBeUndefined();
  });

  it("leaves inaccessible directory workspaces ready and unclaimed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protected directory",
      status: "ready",
      workspace: { kind: "dir", path: "/outside" },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        materializeWorktree: false,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path is outside the caller's allowed workspaces.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { workspace: { kind: "dir", path: "/outside" } } },
    });
  });

  it("does not launch a mutable nested directory for a workspace-bound caller", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Mutable nested directory",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace/repo" },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not let an implicit target agent workspace widen caller access", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Other agent scratch",
      status: "ready",
      agentId: "other",
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: (agentId) =>
          agentId === "other" ? "/workspace-other" : "/workspace",
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("pins an allowed implicit worker to the caller's workspace root", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Workspace scratch",
      status: "ready",
      agentId: "main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-scratch" });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
  });

  it("rejects a restricted card when the target agent is not sandboxed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Restricted worker",
      status: "ready",
      agentId: "broad",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: false,
          workspaceAccess: { unrestricted: true },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "target agent is not sandboxed for this restricted Workboard card.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a restricted card when the target workspace is read-only", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Read-only worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "target agent does not have writable workspace-only access.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps read-only card authority after a later full-host dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Persisted read-only worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringContaining("manual movement is allowed"),
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a target sandbox root broader than the card authority", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Broader target worker",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace/project" },
      workspaceAccess: {
        unrestricted: false,
        roots: ["/workspace/project"],
        writable: true,
      },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a restricted card when the target sandbox has an escape path", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Escaping worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
          confinementError: "target sandbox routes shell execution outside the sandbox.",
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "target sandbox routes shell execution outside the sandbox.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a restricted workspace nested inside a broader Git checkout", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Nested checkout worker",
      status: "ready",
      workspace: { kind: "dir", path: "/repo/workspace" },
      workspaceAccess: { unrestricted: false, roots: ["/repo/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo"),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: () => "/repo/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: {
            unrestricted: false,
            roots: ["/repo/workspace"],
            writable: true,
          },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace root is nested inside a broader Git checkout.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a card's persisted workspace ceiling during a later admin dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Persisted restricted worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/workspace" },
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const create = vi.fn();
    const run = vi.fn().mockResolvedValue({ runId: "run-persisted" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
        create,
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        materializeWorktree: true,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
        workspaceAccess: { unrestricted: true },
      },
    });

    expect(result.started).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
  });

  it("runs an authorized worktree request directly in a workspace-bound caller's root", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Workspace-bound worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-workspace" });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo"),
      hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: {
        maxStarts: 1,
        materializeWorktree: true,
        resolveAgentWorkspace: () => "/repo",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/repo"], writable: true },
        }),
        workspaceAccess: { unrestricted: false, roots: ["/repo"], writable: true },
      },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
    expect(worktrees.create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/repo" } } },
    });
  });

  it("rejects linked-worktree metadata outside a restricted workspace mount", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Linked worktree worker",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace" },
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(false),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "restricted workspace Git metadata must be contained inside its root.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reuse a generated branch as an omitted source base", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Branchless retry",
      status: "ready",
      workspace: {
        kind: "worktree",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: "openclaw/wb-card",
        sourcePath: "/repo",
      },
      workspaceAccess: { unrestricted: true },
    });
    const create = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-retry" }) },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create,
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: { maxStarts: 1, materializeWorktree: true },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", ownerId: card.id }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
  });

  it("claims ready cards and starts bounded subagent worker runs", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First worker",
      status: "ready",
      priority: "urgent",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Second worker",
      status: "ready",
      priority: "normal",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const otherAgent = await store.create({
      title: "Other worker",
      status: "ready",
      priority: "high",
      agentId: "codex-side",
      workspaceAccess: { unrestricted: true },
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
    expect(run.mock.calls[0]?.[0]?.toolsAlsoAllow).toEqual([
      "workboard_heartbeat",
      "workboard_complete",
      "workboard_block",
    ]);
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
      workspaceAccess: { unrestricted: true },
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

  it("starts workers only for the selected board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops worker",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product worker",
      status: "ready",
      priority: "urgent",
      boardId: "product",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-ops" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, boardId: "ops" },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: ops.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `subagent:workboard-ops-${ops.id}`,
      lane: `workboard:ops:${ops.id}`,
    });
    await expect(store.get(product.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { boardId: "product" } },
    });
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
    const card = await store.create({
      title: "Fail worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
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
