// Tests that a pinned-write failure keeps its errno through every write entry point,
// including the public Plugin SDK helper.
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileWithinRoot } from "../plugin-sdk/file-access-runtime.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { root } from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await tempDirs.cleanup();
});

// The rename step runs inside the pinned-write boundary, so a failure here takes the
// same path a real EACCES/ENOSPC takes: fs-safe collapses it into one fixed assertion
// and keeps the original errno on `cause`.
function failPinnedWriteWith(error: Error): void {
  __setFsSafeTestHooksForTest({
    afterPinnedWriteFallbackRename: () => {
      throw error;
    },
  });
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function captureWriteError(write: () => Promise<unknown>): Promise<FsSafeError> {
  const caught = await write().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof FsSafeError)) {
    throw new Error(`expected FsSafeError, got ${String(caught)}`);
  }
  return caught;
}

describe("pinned write errno reporting", () => {
  it("names the errno for Plugin SDK writeFileWithinRoot callers", async () => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-sdk-");
    failPinnedWriteWith(errnoError("EACCES"));

    const error = await captureWriteError(() =>
      writeFileWithinRoot({ rootDir, relativePath: "file.txt", data: "next" }),
    );

    expect(error.message).toBe("permission denied (EACCES)");
    // Callers branch on the code, so naming the errno must not retag the error.
    expect(error.code).toBe("invalid-path");
    expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
  });

  it("names the errno for root().write callers", async () => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-root-");
    failPinnedWriteWith(errnoError("ENOSPC"));

    const error = await captureWriteError(async () =>
      (await root(rootDir)).write("file.txt", "next"),
    );

    expect(error.message).toBe("no space left on device (ENOSPC)");
    expect(error.code).toBe("invalid-path");
  });

  it("leaves the path assertion untouched when the failure carries no errno", async () => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-plain-");
    failPinnedWriteWith(new Error("no errno here"));

    const error = await captureWriteError(() =>
      writeFileWithinRoot({ rootDir, relativePath: "file.txt", data: "next" }),
    );

    expect(error.message).toBe("path is not a regular file under root");
  });
});
