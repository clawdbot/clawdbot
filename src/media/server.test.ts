import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const MEDIA_DIR = path.join(process.cwd(), "tmp-media-test");
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", () => ({
  getMediaDir: () => MEDIA_DIR,
  cleanOldMedia,
}));

const { startMediaServer } = await import("./server.js");

const waitForFileRemoval = async (file: string, timeoutMs = 200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(file);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${file} removal`);
};

describe("media server", () => {
  beforeAll(async () => {
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
    await fs.mkdir(MEDIA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
  });

  it("serves media and cleans up after send", async () => {
    const file = path.join(MEDIA_DIR, "file1");
    await fs.writeFile(file, "hello");
    const server = await startMediaServer(0, 5_000);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://localhost:${port}/media/file1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    await waitForFileRemoval(file);
    await new Promise((r) => server.close(r));
  });

  it("expires old media", async () => {
    const file = path.join(MEDIA_DIR, "old");
    await fs.writeFile(file, "stale");
    const past = Date.now() - 10_000;
    await fs.utimes(file, past / 1000, past / 1000);
    const server = await startMediaServer(0, 1_000);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://localhost:${port}/media/old`);
    expect(res.status).toBe(410);
    await expect(fs.stat(file)).rejects.toThrow();
    await new Promise((r) => server.close(r));
  });

  it("blocks path traversal attempts", async () => {
    const server = await startMediaServer(0, 5_000);
    const port = (server.address() as AddressInfo).port;
    // URL-encoded "../" to bypass client-side path normalization
    const res = await fetch(`http://localhost:${port}/media/%2e%2e%2fpackage.json`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
    await new Promise((r) => server.close(r));
  });

  it("blocks symlink escaping outside media dir", async () => {
    const target = path.join(process.cwd(), "package.json"); // outside MEDIA_DIR
    const link = path.join(MEDIA_DIR, "link-out");
    await fs.symlink(target, link);

    const server = await startMediaServer(0, 5_000);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://localhost:${port}/media/link-out`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
    await new Promise((r) => server.close(r));
  });
});
