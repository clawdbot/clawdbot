import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

import { downloadVerifiedFile } from "./llama-server-install.js";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.fetchWithSsrFGuard.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createDestination(): Promise<{ destination: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-download-"));
  tempRoots.push(root);
  return { destination: path.join(root, "model.gguf"), root };
}

function mockDownload(payload: Buffer): ReturnType<typeof vi.fn> {
  const release = vi.fn();
  mocks.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(new Uint8Array(payload), {
      headers: { "content-length": String(payload.byteLength) },
    }),
    release,
  });
  return release;
}

function injectFileHandle(customize: (handle: FileHandle) => void): void {
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    customize(handle);
    return handle;
  });
}

function installWriteFileThroughWrite(handle: FileHandle): void {
  handle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
    const buffer =
      typeof data === "string"
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
      if (bytesWritten === 0) {
        throw new Error("injected zero-byte write");
      }
      offset += bytesWritten;
    }
  }) as typeof handle.writeFile;
}

describe("downloadVerifiedFile", () => {
  it("persists complete chunks before reporting progress under positive short writes", async () => {
    const payload = Buffer.from("short writes must not truncate verified downloads");
    const { destination, root } = await createDestination();
    const release = mockDownload(payload);
    const onProgress = vi.fn();
    const writes: number[] = [];
    injectFileHandle((handle) => {
      const actualWrite = handle.write.bind(handle);
      let firstWrite = true;
      handle.write = (async (
        buffer: Uint8Array,
        offset?: number | null,
        length?: number | null,
        position?: number | null,
      ) => {
        const start = offset ?? 0;
        const requested = length ?? buffer.byteLength - start;
        const result = await actualWrite(
          buffer,
          start,
          firstWrite ? Math.min(7, requested) : requested,
          position,
        );
        firstWrite = false;
        writes.push(result.bytesWritten);
        return result;
      }) as typeof handle.write;
      installWriteFileThroughWrite(handle);
    });

    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
      expectedSize: payload.byteLength,
      onProgress,
    });

    expect(await fs.readFile(destination)).toEqual(payload);
    expect(writes[0]).toBe(7);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.reduce((total, size) => total + size, 0)).toBe(payload.byteLength);
    const published = await fs.stat(destination);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ downloadedSize: published.size, totalSize: payload.byteLength }),
    );
    if (process.platform !== "win32") {
      expect(published.mode & 0o777).toBe(0o600);
    }
    expect(release).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual(["model.gguf"]);
  });

  it("keeps the destination absent and removes the partial file after a write failure", async () => {
    const payload = Buffer.from("a download that cannot be persisted");
    const { destination, root } = await createDestination();
    const release = mockDownload(payload);
    injectFileHandle((handle) => {
      handle.write = vi.fn(async () => {
        throw new Error("injected write failure");
      }) as typeof handle.write;
      installWriteFileThroughWrite(handle);
    });

    await expect(
      downloadVerifiedFile({
        url: "https://downloads.example/model.gguf",
        destination,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
        expectedSize: payload.byteLength,
      }),
    ).rejects.toThrow("injected write failure");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
});
