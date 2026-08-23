import { describe, expect, it } from "vitest";
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
});
