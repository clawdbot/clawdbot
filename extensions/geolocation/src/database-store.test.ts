import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGeolocationSettings } from "./config.js";
import { createGeolocationDatabaseStore } from "./database-store.js";

const created: string[] = [];

async function tempStateDir(): Promise<string> {
  // Realpath first: macOS tmp is a symlink and the store compares resolved paths.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geolocation-store-")));
  created.push(dir);
  return dir;
}

function jsonResponse(body: Buffer, ok = true): Response {
  // The store streams the body, so the fake exposes a reader rather than
  // arrayBuffer: an oversized response must be rejected mid-read.
  return {
    ok,
    status: ok ? 200 : 404,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) {
              return { done: true, value: undefined };
            }
            sent = true;
            return { done: false, value: new Uint8Array(body) };
          },
          async cancel() {},
        };
      },
    },
  } as unknown as Response;
}

function chunkedResponse(chunkBytes: number, chunkCount: number): Response {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let emitted = 0;
        return {
          async read() {
            if (emitted >= chunkCount) {
              return { done: true, value: undefined };
            }
            emitted += 1;
            return { done: false, value: new Uint8Array(chunkBytes) };
          },
          async cancel() {},
        };
      },
    },
  } as unknown as Response;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("geolocation database store", () => {
  it("tries the previous month when the current build is not published yet", async () => {
    const stateDir = await tempStateDir();
    const fetchImpl = vi.fn(async () => jsonResponse(Buffer.from("nope"), false));
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({
        databaseUrl: "https://host.test/db-{yyyy}-{mm}.mmdb",
      }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/db-2026-01.*db-2025-12/s);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to publish an unparsable body, leaving no database behind", async () => {
    const stateDir = await tempStateDir();
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: (async () =>
        jsonResponse(Buffer.from("<html>rate limited</html>"))) as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/db\.mmdb/);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });

  it("downloads once when concurrent callers race the first lookup", async () => {
    const stateDir = await tempStateDir();
    const fetchImpl = vi.fn(async () => jsonResponse(Buffer.from("garbage")));
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await Promise.allSettled([store.load(), store.load(), store.load()]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("names the source in the cache path so a swapped source cannot reuse the old data", async () => {
    const stateDir = await tempStateDir();
    const settingsFor = (databaseUrl: string) =>
      createGeolocationDatabaseStore({
        stateDir,
        settings: resolveGeolocationSettings({ databaseUrl }),
        now: () => new Date("2026-01-03T00:00:00Z"),
        fetchImpl: (async () => jsonResponse(Buffer.from(""))) as unknown as typeof fetch,
      }).databaseFile;

    expect(settingsFor("https://a.test/db.mmdb")).not.toBe(settingsFor("https://b.test/db.mmdb"));
  });

  it("rejects an oversized body while reading instead of after allocating it", async () => {
    const stateDir = await tempStateDir();
    // 3 chunks of 128 MiB exceeds the 256 MiB compressed ceiling on the third
    // read, so the reader must stop rather than buffer the whole response.
    const chunkBytes = 128 * 1024 * 1024;
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: (async () => chunkedResponse(chunkBytes, 3)) as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/exceeded the \d+ byte cap/);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });

  it("refuses a gzip source that inflates past the on-disk ceiling", async () => {
    const stateDir = await tempStateDir();
    // A highly compressible payload stands in for a compression bomb: the
    // compressed bytes are tiny, the inflated output is what must be bounded.
    const inflated = Buffer.alloc(700 * 1024 * 1024, 0);
    const compressed = gzipSync(inflated);
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb.gz" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: (async () => jsonResponse(compressed)) as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/db\.mmdb\.gz/);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });
});
