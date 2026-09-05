import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { privateFileStore, privateFileStoreSync } from "./private-file-store.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-private-store-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("privateFileStore root tightening", () => {
  it("tightens a world-readable store root at creation", async () => {
    const dir = await createTempDir();
    if (process.platform === "win32") {
      return;
    }
    await fsPromises.chmod(dir, 0o777);

    const store = privateFileStore(dir);
    await store.writeText("ok.txt", "ok");

    const stat = await fsPromises.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(await store.readText("ok.txt")).toBe("ok");
  });

  it("never chmods a symlinked store root's destination", async () => {
    const parent = await createTempDir();
    const targetDir = await createTempDir();
    if (process.platform === "win32") {
      return;
    }
    await fsPromises.chmod(targetDir, 0o777);
    const rootLink = path.join(parent, "store-link");
    await fsPromises.symlink(targetDir, rootLink);

    const store = privateFileStore(rootLink);
    await expect(store.writeText("ok.txt", "ok")).rejects.toThrow();

    const targetStat = await fsPromises.stat(targetDir);
    expect(targetStat.mode & 0o777).toBe(0o777);
  });

  it("sync factory also leaves a symlinked store root untouched", async () => {
    const parent = await createTempDir();
    const targetDir = await createTempDir();
    if (process.platform === "win32") {
      return;
    }
    await fsPromises.chmod(targetDir, 0o777);
    const rootLink = path.join(parent, "store-link");
    await fsPromises.symlink(targetDir, rootLink);

    const store = privateFileStoreSync(rootLink);
    expect(() => store.write("ok.txt", "ok")).toThrow();

    const targetStat = await fsPromises.stat(targetDir);
    expect(targetStat.mode & 0o777).toBe(0o777);
  });
});
