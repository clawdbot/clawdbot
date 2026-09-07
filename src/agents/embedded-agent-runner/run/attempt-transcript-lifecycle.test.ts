import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

describe("createEmbeddedAttemptTranscriptLifecycle", () => {
  it("drains admitted transcript writes before cleanup continues", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId: "run-a",
      sessionId: "session-a",
    });
    let releaseWrite = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = lifecycle.withTranscriptWrite(async () => {
      await writeGate;
    });
    const cleanup = lifecycle.beginCleanup();

    let cleanupSettled = false;
    void cleanup.then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    releaseWrite();
    await expect(write).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    await expect(lifecycle.withTranscriptWrite(() => undefined)).rejects.toThrow(
      "attempt cleanup started before transcript write",
    );
  });

  it("drains fire-and-forget nested writes before admitting the next writer", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    const order: string[] = [];
    await lifecycle.withTranscriptWrite(() => {
      order.push("outer");
      void lifecycle.withTranscriptWrite(async () => {
        await Promise.resolve();
        order.push("nested");
      });
    });
    await lifecycle.withTranscriptWrite(() => {
      order.push("next");
    });
    expect(order).toEqual(["outer", "nested", "next"]);
  });

  it("rejects cleanup started from inside a transcript callback", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    await lifecycle.withTranscriptWrite(async () => {
      await expect(lifecycle.beginCleanup()).rejects.toThrow(
        "cannot start attempt cleanup inside a transcript write callback",
      );
    });
  });

  it("still admits a nested write from a callback that outlives the teardown budget", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
      let releaseWrite = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let nestedWrite: Promise<undefined> | undefined;
      const admitted = lifecycle.withTranscriptWrite(async () => {
        await writeGate; // outlives the teardown budget
        // Once dispose() returns (budget expired, callback still running), a nested
        // write from this callback must still be admitted as a descendant. The owned
        // store is only disabled once the actual drain settles, never on the budget.
        nestedWrite = lifecycle.withTranscriptWrite(() => undefined);
      });
      const disposeDone = lifecycle.dispose();
      await vi.advanceTimersByTimeAsync(30_000); // expire the teardown budget
      await disposeDone;
      releaseWrite();
      await admitted;
      // If the store had been disabled when the budget expired, this nested write
      // would be rejected as disposed instead of admitted.
      await expect(nestedWrite).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases its per-attempt AsyncLocalStorage after dispose (retention child)", async () => {
    const entrypoint = new URL(
      "./attempt-transcript-lifecycle.retention.test-support.ts",
      import.meta.url,
    );
    // The leak control asserts that never-disposed stores stay retained. That is
    // only true on the legacy AsyncLocalStorage (a global storageList). Node 24+
    // defaults to AsyncContextFrame, where completed contexts are collected even
    // without .disable(); select the legacy implementation there so the control
    // stays meaningful on the repository's recommended runtime.
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const contextFlag = nodeMajor >= 24 ? ["--no-async-context-frame"] : [];
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", ...contextFlag, "--import", "tsx", fileURLToPath(entrypoint)],
      { timeout: 20_000 },
    );
    expect(stdout).toContain("retention ok");
  }, 25_000);
});
