import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createWorktreesHandlers } from "./worktrees.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function call(
  handlers: ReturnType<typeof createWorktreesHandlers>,
  method: keyof ReturnType<typeof createWorktreesHandlers>,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  await handlers[method]?.({ params, respond } as never);
  return respond.mock.calls[0];
}

describe("worktrees.remove/restore padded ids on live registry", () => {
  it("removes and restores through real Git + registry when ids are padded", async () => {
    const root = tempDirs.make("openclaw-worktrees-gateway-trim-");
    const repoRoot = await initializeManagedWorktreeTestRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const service = new ManagedWorktreeService({ env });
    const handlers = createWorktreesHandlers(service);

    const created = await service.create({
      repoRoot,
      name: "pad-remove",
      baseRef: "HEAD",
      ownerKind: "manual",
    });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    await fs.stat(created.path);

    await expect(
      service.remove({ id: ` ${created.id} `, reason: "manual-delete" }),
    ).rejects.toThrow(/unknown active worktree/);

    const removeResult = await call(handlers, "worktrees.remove", {
      id: ` ${created.id} `,
      force: true,
    });
    expect(removeResult?.[0]).toBe(true);
    expect(removeResult?.[1]).toMatchObject({ removed: true });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toEqual(expect.any(Number));
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });

    const restoreResult = await call(handlers, "worktrees.restore", { id: ` ${created.id} ` });
    expect(restoreResult?.[0]).toBe(true);
    expect(restoreResult?.[1]).toMatchObject({ id: created.id, path: created.path });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
  });
});
