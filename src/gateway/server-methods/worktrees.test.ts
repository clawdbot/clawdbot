import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorktreeSnapshotError } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { createWorktreesHandlers } from "./worktrees.js";

const record: ManagedWorktreeRecord = {
  id: "worktree-id",
  name: "task-one",
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/repo",
  path: "/state/worktrees/0123456789abcdef/task-one",
  branch: "openclaw/task-one",
  baseRef: "HEAD",
  ownerKind: "manual",
  createdAt: 1,
  lastActiveAt: 2,
};

async function call(
  handlers: ReturnType<typeof createWorktreesHandlers>,
  method: keyof ReturnType<typeof createWorktreesHandlers>,
  params: Record<string, unknown>,
  extras: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await handlers[method]?.({ params, respond, ...extras } as never);
  return respond.mock.calls[0];
}

const adminClient = { connect: { scopes: ["operator.admin"] } };
const writeClient = { connect: { scopes: ["operator.write"] } };
const emptyConfigContext = { getRuntimeConfig: () => ({}) };

describe("worktrees gateway methods", () => {
  it("routes every operation through the managed worktree service", async () => {
    const service = {
      list: vi.fn(async () => [record]),
      create: vi.fn(async () => record),
      remove: vi.fn(async () => ({ removed: true, snapshotRef: "refs/snapshot" })),
      restore: vi.fn(async () => ({ ...record, snapshotRef: "refs/snapshot" })),
      gc: vi.fn(async () => ({ removed: [record.id], orphansDeleted: 1, snapshotsPruned: 2 })),
    };
    const handlers = createWorktreesHandlers(service as never);

    expect(await call(handlers, "worktrees.list", {})).toEqual([
      true,
      { worktrees: [record] },
      undefined,
    ]);
    expect(
      await call(handlers, "worktrees.create", {
        repoRoot: "/repo",
        name: "task-one",
        baseRef: "main",
      }),
    ).toEqual([true, record, undefined]);
    expect(await call(handlers, "worktrees.remove", { id: record.id, force: true })).toEqual([
      true,
      { removed: true, snapshotRef: "refs/snapshot" },
      undefined,
    ]);
    const restoreResult = expectDefined(
      await call(handlers, "worktrees.restore", { id: record.id }),
      "worktree restore response",
    );
    expect(expectDefined(restoreResult[0], "worktree restore success flag")).toBe(true);
    expect(await call(handlers, "worktrees.gc", {}, { context: emptyConfigContext })).toEqual([
      true,
      { removed: [record.id], orphansDeleted: 1, snapshotsPruned: 2 },
      undefined,
    ]);
    expect(service.gc).toHaveBeenCalledWith({
      limits: {},
      shouldProtectOwner: expect.any(Function),
    });

    expect(service.create).toHaveBeenCalledWith({
      repoRoot: "/repo",
      name: "task-one",
      baseRef: "main",
      ownerKind: "manual",
    });
    expect(service.remove).toHaveBeenCalledWith({
      id: record.id,
      reason: "manual-delete",
      force: true,
    });
  });

  it("lists branches for admin clients and configured workspaces only", async () => {
    const service = {
      listRepositoryBranches: vi.fn(async () => ({
        branches: [{ name: "main", kind: "local" as const }],
        defaultBranch: "main",
      })),
    };
    const handlers = createWorktreesHandlers(service as never);

    const adminResponse = await call(
      handlers,
      "worktrees.branches",
      { repoRoot: "/anywhere" },
      { client: adminClient, context: emptyConfigContext },
    );
    expect(adminResponse?.[0]).toBe(true);
    expect(service.listRepositoryBranches).toHaveBeenCalledWith("/anywhere");

    const statusResponse = await call(
      handlers,
      "worktrees.branches",
      { repoRoot: "/anywhere", includeRepositoryStatus: true },
      { client: adminClient, context: emptyConfigContext },
    );
    expect(statusResponse?.[0]).toBe(true);
    expect(service.listRepositoryBranches).toHaveBeenCalledWith("/anywhere", {
      includeRepositoryStatus: true,
    });

    // Write scope cannot probe arbitrary host paths for branch names.
    const denied = await call(
      handlers,
      "worktrees.branches",
      { repoRoot: "/anywhere" },
      { client: writeClient, context: emptyConfigContext },
    );
    expect(denied?.[0]).toBe(false);
    expect(String((denied?.[2] as { message?: string })?.message)).toContain("operator.admin");
  });

  it("allows write-scoped branch listing for a configured agent workspace", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-branches-scope-"),
    );
    try {
      const service = {
        listRepositoryBranches: vi.fn(async () => ({ branches: [] })),
      };
      const handlers = createWorktreesHandlers(service as never);
      const response = await call(
        handlers,
        "worktrees.branches",
        { repoRoot: workspace },
        {
          client: writeClient,
          context: {
            getRuntimeConfig: () => ({
              agents: { list: [{ id: "main", default: true, workspace }] },
            }),
          },
        },
      );
      expect(response?.[0]).toBe(true);
      expect(service.listRepositoryBranches).toHaveBeenCalledWith(workspace);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the built-in cleanup policy for gc", async () => {
    const service = {
      gc: vi.fn(async () => ({ removed: [], orphansDeleted: 0, snapshotsPruned: 0 })),
    };
    const handlers = createWorktreesHandlers(service as never);
    const context = { getRuntimeConfig: () => ({}) };
    const response = await call(handlers, "worktrees.gc", {}, { context });
    expect(response?.[0]).toBe(true);
    expect(service.gc).toHaveBeenCalledWith({
      limits: {},
      shouldProtectOwner: expect.any(Function),
    });
  });

  it("maps snapshot failures onto a structured removed=false result", async () => {
    const service = {
      remove: vi.fn(async () => {
        throw new WorktreeSnapshotError("nested gitlink");
      }),
    };
    const handlers = createWorktreesHandlers(service as never);
    expect(await call(handlers, "worktrees.remove", { id: record.id })).toEqual([
      true,
      { removed: false, snapshotError: "nested gitlink" },
      undefined,
    ]);
  });

  it("rejects invalid parameters", async () => {
    const handlers = createWorktreesHandlers({} as never);
    const response = await call(handlers, "worktrees.create", { repoRoot: "" });

    expect(response?.[0]).toBe(false);
  });
});
