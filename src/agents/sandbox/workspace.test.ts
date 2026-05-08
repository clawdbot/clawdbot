import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS_FILENAME } from "../workspace.js";
import { ensureSandboxWorkspace } from "./workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-workspace-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ensureSandboxWorkspace", () => {
  it("seeds regular bootstrap files from the source workspace", async () => {
    const root = await makeTempRoot();
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), "seeded-agents", "utf-8");

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).resolves.toBe(
      "seeded-agents",
    );
  });

  it.runIf(process.platform !== "win32")("skips symlinked bootstrap seed files", async () => {
    const root = await makeTempRoot();
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const outside = path.join(root, "outside-secret.txt");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(outside, "secret", "utf-8");
    await fs.symlink(outside, path.join(seed, DEFAULT_AGENTS_FILENAME));

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).rejects.toThrow(
      "no such file",
    );
  });

  it.runIf(process.platform !== "win32")("skips hardlinked bootstrap seed files", async () => {
    const root = await makeTempRoot();
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const outside = path.join(root, "outside-agents.txt");
    const linkedSeed = path.join(seed, DEFAULT_AGENTS_FILENAME);
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(outside, "outside", "utf-8");
    try {
      await fs.link(outside, linkedSeed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).rejects.toThrow(
      "no such file",
    );
  });
});
