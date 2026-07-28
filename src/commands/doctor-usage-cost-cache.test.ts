// Covers doctor cleanup of legacy usage-cost cache sidecars.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybeRepairLegacyRuntimeFiles } from "./doctor-usage-cost-cache.js";

let root: string | undefined;

afterEach(async () => {
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("legacy usage-cost cache cleanup", () => {
  it("removes only rebuildable usage-cost cache sidecars", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-cost-doctor-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const cacheFiles = [
      path.join(sessionsDir, ".usage-cost-cache.json"),
      path.join(sessionsDir, ".usage-cost-cache.json.lock"),
    ];
    const staleTempFiles = [
      path.join(sessionsDir, ".usage-cost-cache.123.3b241101-e2bb-4255-8caf-4136c566a962.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.json.lock.123.456.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.json.123.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.123.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.json.lock.123.tmp"),
    ];
    const recentTemp = path.join(sessionsDir, ".usage-cost-cache.456.tmp");
    const transcript = path.join(sessionsDir, "session.jsonl");
    const unrelatedFiles = [
      transcript,
      path.join(sessionsDir, ".usage-cost-cache.backup"),
      path.join(sessionsDir, ".usage-cost-cache.notes"),
    ];
    await Promise.all(
      [...cacheFiles, ...staleTempFiles, recentTemp, ...unrelatedFiles].map((filePath) =>
        fs.writeFile(filePath, "x"),
      ),
    );
    const staleTime = new Date(Date.now() - 60_000);
    await Promise.all(staleTempFiles.map((filePath) => fs.utimes(filePath, staleTime, staleTime)));
    const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;

    await maybeRepairLegacyRuntimeFiles(true, env);

    for (const filePath of [...cacheFiles, ...staleTempFiles]) {
      await expect(fs.readFile(filePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const filePath of [recentTemp, ...unrelatedFiles]) {
      await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("x");
    }
  });

  it("reports legacy skill-upload staging without deleting it unless repair is enabled", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-upload-doctor-"));
    const uploadRoot = path.join(root, "tmp", "skill-uploads");
    const metadataPath = path.join(uploadRoot, randomUploadId(), "metadata.json");
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(metadataPath, "{}\n", "utf8");
    const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;

    await maybeRepairLegacyRuntimeFiles(false, env);
    await expect(fs.readFile(metadataPath, "utf8")).resolves.toBe("{}\n");

    await maybeRepairLegacyRuntimeFiles(true, env);
    await expect(fs.stat(uploadRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  const symlinkTest = process.platform === "win32" ? it.skip : it;
  symlinkTest("removes a legacy staging symlink without touching its target", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-upload-link-"));
    const uploadRoot = path.join(root, "tmp", "skill-uploads");
    const external = path.join(root, "external");
    await fs.mkdir(path.dirname(uploadRoot), { recursive: true });
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "keep.txt"), "keep", "utf8");
    await fs.symlink(external, uploadRoot, "dir");

    await maybeRepairLegacyRuntimeFiles(true, {
      OPENCLAW_STATE_DIR: root,
    } as NodeJS.ProcessEnv);

    await expect(fs.lstat(uploadRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(external, "keep.txt"), "utf8")).resolves.toBe("keep");
  });
});

function randomUploadId(): string {
  return "11111111-1111-4111-8111-111111111111";
}
