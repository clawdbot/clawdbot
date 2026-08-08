// Media store retry tests cover the exact directory-recreation recovery boundary.
import fs from "node:fs/promises";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { FsSafeError } from "../infra/fs-safe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.doUnmock("../infra/file-store.js");
  vi.unstubAllEnvs();
  vi.resetModules();
});

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("media store directory recreation", () => {
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
              if (args[0].includes(`${segment}${path.sep}`) && writeAttempts++ === 0) {
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
});
