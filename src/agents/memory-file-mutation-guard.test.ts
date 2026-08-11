import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryFileMutationGuard } from "./memory-file-mutation-guard.js";

const roots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-mutation-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("memory file mutation guard", () => {
  it("rejects legacy memory roots without disclosing which path matched", async () => {
    const workspace = await createWorkspace();
    const guard = createMemoryFileMutationGuard({ mutationRoot: workspace });
    const denied = [
      "MEMORY.md",
      "memory.md",
      "USER.md",
      "memory",
      "memory/2026-08-10.md",
      "memory/nested/state.sqlite",
    ];

    for (const relativePath of denied) {
      await expect(guard.assertCanMutate(path.join(workspace, relativePath))).rejects.toThrow(
        "Legacy memory file mutations are unavailable for this agent.",
      );
    }
  });

  it("allows normal workspace files and does not treat a similarly named directory as memory", async () => {
    const workspace = await createWorkspace();
    const guard = createMemoryFileMutationGuard({ mutationRoot: workspace });

    await expect(
      guard.assertCanMutate(path.join(workspace, "notes", "today.md")),
    ).resolves.toBeUndefined();
    await expect(
      guard.assertCanMutate(path.join(workspace, "memories", "today.md")),
    ).resolves.toBeUndefined();
  });
});
