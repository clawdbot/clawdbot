// Media store filesystem-fault tests cover directory recreation and short writes.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { FsSafeError } from "../infra/fs-safe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../infra/file-store.js");
  vi.unstubAllEnvs();
  vi.resetModules();
});

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("media store filesystem faults", () => {
  it.each([
    {
      name: "ENOTDIR",
      error: () => errnoError("ENOTDIR"),
      shouldRetry: false,
    },
    {
      name: "standalone fs-safe not-found",
      error: () => new FsSafeError("not-found", "media target not found"),
      shouldRetry: false,
    },
    {
      name: "fs-safe not-found wrapping ENOENT",
      error: () =>
        new FsSafeError("not-found", "media target not found", {
          cause: errnoError("ENOENT"),
        }),
      shouldRetry: true,
    },
  ])("surfaces or retries $name according to its exact cause", async ({ error, shouldRetry }) => {
    const stateDir = tempDirs.make("openclaw-media-retry-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const segment = `retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const injectedError = error();
    let writeAttempts = 0;
    vi.doMock("../infra/file-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/file-store.js")>();
      return {
        ...actual,
        fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
          const actualStore = actual.fileStore(options);
          return {
            ...actualStore,
            write: async (...args: Parameters<typeof actualStore.write>) => {
              if (args[0].includes(`${segment}/`) && writeAttempts++ === 0) {
                throw injectedError;
              }
              return await actualStore.write(...args);
            },
          };
        },
      };
    });

    const store = await importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      `./store.js?scope=retry-boundary-${segment}`,
    );
    const result = store.saveMediaBuffer(Buffer.from("voice"), "audio/ogg", segment);
    if (shouldRetry) {
      const saved = await result;
      await expect(fs.stat(saved.path)).resolves.toMatchObject({ size: 5 });
      expect(writeAttempts).toBe(2);
      return;
    }
    await expect(result).rejects.toBe(injectedError);
    expect(writeAttempts).toBe(1);
  });

  it("fully persists a stream chunk after a positive short write", async () => {
    const stateDir = tempDirs.make("openclaw-media-short-write-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const input = Buffer.from("positive short write");
    const originalOpen = fs.open.bind(fs);
    let shortWriteObserved = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== "string" ||
        !args[0].includes(`${path.sep}short-write-stream${path.sep}`) ||
        args[1] !== "wx"
      ) {
        return handle;
      }

      let injectShortWrite = true;
      const injectedHandle = Object.create(handle) as typeof handle;
      injectedHandle.close = handle.close.bind(handle);
      injectedHandle.write = (async (
        buffer: Buffer,
        offset = 0,
        length = buffer.byteLength - offset,
      ) => {
        const writeLength = injectShortWrite ? Math.max(1, Math.floor(length / 2)) : length;
        injectShortWrite = false;
        shortWriteObserved ||= writeLength < length;
        return await handle.write(buffer, offset, writeLength);
      }) as typeof handle.write;
      injectedHandle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
        const buffer =
          typeof data === "string"
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesWritten } = await injectedHandle.write(
            buffer,
            offset,
            buffer.byteLength - offset,
          );
          offset += bytesWritten;
        }
      }) as typeof handle.writeFile;
      return injectedHandle;
    });

    const store = await importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      "./store.js?scope=positive-short-write",
    );
    const saved = await store.saveMediaStream(
      Readable.from([input]),
      "text/plain",
      "short-write-stream",
      1024,
    );

    expect(shortWriteObserved).toBe(true);
    expect(saved.size).toBe(input.byteLength);
    await expect(fs.readFile(saved.path)).resolves.toEqual(input);
  });
});
