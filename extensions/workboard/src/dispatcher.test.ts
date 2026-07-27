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
  it("persists the resolved subagent runtime on new executions", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Claude worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({
      runId: "run-claude",
      runtime: {
        harness: "claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      execution: {
        id: `${card.id}:agent-session`,
        engine: "claude-cli",
        model: "anthropic/claude-sonnet-4-6",
        runId: "run-claude",
      },
    });
  });

  it("omits unresolved runtime metadata instead of labeling it codex", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Unknown runtime worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-unknown" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const execution = (await store.get(card.id))?.execution;
    expect(execution).toMatchObject({
      id: `${card.id}:agent-session`,
      runId: "run-unknown",
    });
    expect(execution).not.toHaveProperty("engine");
    expect(execution).not.toHaveProperty("model");
  });

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
    expect(run.mock.calls[0]?.[0]?.message).toContain("returned proofId");
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

  it("shares one worker slot across cards dispatched with the same explicit owner", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First shared worker",
      status: "ready",
      priority: "urgent",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Second shared worker",
      status: "ready",
      agentId: "beta",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-shared" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, ownerId: " shared-worker " },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: first.id, runId: "run-shared" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("counts the active claim owner when checking worker capacity", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const running = await store.create({
      title: "Already claimed worker",
      status: "running",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(running.id, { ownerId: "shared-worker", token: "shared-token" });
    const ready = await store.create({
      title: "Waiting for the shared owner",
      status: "ready",
      agentId: "beta",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, ownerId: "shared-worker" },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(ready.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not let an expired review claim consume worker capacity", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const now = Date.now();
    await store.create({
      title: "Expired review claim",
      status: "review",
      agentId: "shared-worker",
      metadata: {
        claim: {
          ownerId: "shared-worker",
          token: "expired-token",
          claimedAt: now - 60_000,
          lastHeartbeatAt: now - 60_000,
          expiresAt: now - 1_000,
        },
      },
    });
    const ready = await store.create({
      title: "Ready after expired review claim",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-after-expiry" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: ready.id, runId: "run-after-expiry" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    { wallClock: 10_000, dispatchNow: 50_000, expectedStarts: 1 },
    { wallClock: 50_000, dispatchNow: 10_000, expectedStarts: 0 },
  ])(
    "evaluates claim capacity at dispatch time instead of wall time ($wallClock, $dispatchNow)",
    async ({ wallClock, dispatchNow, expectedStarts }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(wallClock);
        const store = new WorkboardStore(createMemoryStore());
        await store.create({
          title: "Review claim with a deterministic expiry",
          status: "review",
          agentId: "shared-worker",
          metadata: {
            claim: {
              ownerId: "shared-worker",
              token: "timed-token",
              claimedAt: 1_000,
              lastHeartbeatAt: 1_000,
              expiresAt: 20_000,
            },
          },
        });
        const ready = await store.create({
          title: "Worker using dispatch-time capacity",
          status: "ready",
          agentId: "shared-worker",
          workspaceAccess: { unrestricted: true },
        });
        const run = vi.fn().mockResolvedValue({ runId: "run-at-dispatch-time" });

        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { now: dispatchNow, maxStarts: 1 },
        });

        expect(run).toHaveBeenCalledTimes(expectedStarts);
        expect(result.started).toHaveLength(expectedStarts);
        if (expectedStarts === 1) {
          expect(result.started[0]).toMatchObject({
            cardId: ready.id,
            runId: "run-at-dispatch-time",
          });
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("replaces an expired ready-card claim without waiting for stale-claim cleanup", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const now = Date.now();
    const card = await store.create({
      title: "Ready with an expired lease",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
      metadata: {
        claim: {
          ownerId: "retired-worker",
          token: "expired-token",
          claimedAt: now - 60_000,
          lastHeartbeatAt: now - 60_000,
          expiresAt: now - 1_000,
        },
      },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-reclaimed" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-reclaimed" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    expect((await store.get(card.id))?.metadata?.claim?.token).not.toBe("expired-token");
  });

  it.each(["worker", "other-worker"])(
    "starts recoverable work after a higher-priority worker fails (next owner: %s)",
    async (nextOwner) => {
      const store = new WorkboardStore(createMemoryStore());
      const failed = await store.create({
        title: "Unavailable urgent worker",
        status: "ready",
        priority: "urgent",
        agentId: "worker",
        workspaceAccess: { unrestricted: true },
      });
      const recovered = await store.create({
        title: "Recoverable queued worker",
        status: "ready",
        agentId: nextOwner,
        workspaceAccess: { unrestricted: true },
      });
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("model unavailable"))
        .mockResolvedValueOnce({ runId: "run-recovered" });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { now: 10, maxStarts: 1 },
      });

      expect(run).toHaveBeenCalledTimes(2);
      expect(result.started).toEqual([
        expect.objectContaining({ cardId: recovered.id, runId: "run-recovered" }),
      ]);
      expect(result.startFailures).toEqual([
        expect.objectContaining({ cardId: failed.id, error: "model unavailable" }),
      ]);
      await expect(store.get(failed.id)).resolves.toMatchObject({ status: "blocked" });
      await expect(store.get(recovered.id)).resolves.toMatchObject({ status: "running" });
    },
  );

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

  it("serializes concurrent board dispatches for the same worker", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops shared worker",
      status: "ready",
      boardId: "ops",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product shared worker",
      status: "ready",
      boardId: "product",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const originalList = store.list.bind(store);
    let snapshotCount = 0;
    let releaseSnapshots: (() => void) | undefined;
    const snapshotsReleased = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const cards = await originalList(options);
      if (options === undefined && snapshotCount < 2) {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          releaseTimer = setTimeout(() => releaseSnapshots?.(), 0);
        } else {
          if (releaseTimer !== undefined) {
            clearTimeout(releaseTimer);
          }
          releaseSnapshots?.();
        }
        await snapshotsReleased;
      }
      return cards;
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-shared-board" });

    const results = await Promise.all([
      dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId: "ops", maxStarts: 1 },
      }),
      dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId: "product", maxStarts: 1 },
      }),
    ]);

    expect(run).toHaveBeenCalledOnce();
    expect(results.flatMap((result) => result.started)).toEqual([
      expect.objectContaining({ cardId: ops.id, runId: "run-shared-board" }),
    ]);
    await expect(store.get(ops.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expect(store.get(product.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps one worker slot across 25 concurrent board dispatches", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const cards = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.create({
          title: `Concurrent worker ${index}`,
          status: "ready",
          boardId: `board-${index}`,
          agentId: "shared-worker",
          workspaceAccess: { unrestricted: true },
        }),
      ),
    );
    const run = vi.fn().mockResolvedValue({ runId: "run-concurrent" });

    const results = await Promise.all(
      cards.map((card) =>
        dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { boardId: card.metadata?.automation?.boardId, maxStarts: 1 },
        }),
      ),
    );

    expect(run).toHaveBeenCalledOnce();
    expect(results.flatMap((result) => result.started)).toHaveLength(1);
    const persisted = await store.list();
    expect(persisted.filter((card) => card.status === "running")).toHaveLength(1);
    expect(persisted.filter((card) => card.status === "ready")).toHaveLength(24);
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

  it("preserves an accepted worker claim when execution persistence fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Worker with unavailable execution persistence",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-awaiting-persistence" });
    vi.spyOn(store, "update").mockRejectedValueOnce(new Error("execution persistence unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "execution persistence unavailable",
      }),
    ]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
    await expect(
      store.heartbeat(card.id, { ownerId: "workboard-dispatcher" }),
    ).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });

    const retry = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(retry.started).toEqual([]);
    expect(retry.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an accepted worker running when its worker log cannot be recorded", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Worker with unavailable logging",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-without-log" });
    vi.spyOn(store, "addWorkerLog").mockRejectedValueOnce(new Error("logger unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-without-log" }),
    ]);
    expect(result.startFailures).toEqual([]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-without-log",
      execution: { status: "running", runId: "run-without-log" },
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
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
