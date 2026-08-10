import { describe, expect, it, vi } from "vitest";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";

describe("prepareEmbeddedAttemptTranscriptLifecycle", () => {
  it("carries the admitted writer fence into nested transcript writes", async () => {
    const externalAbortController = {
      arm: vi.fn(),
      throwIfFiredAfterPrepCleanup: vi.fn(async () => undefined),
    };
    const prepared = await prepareEmbeddedAttemptTranscriptLifecycle({
      attempt: {
        config: {},
        runId: "run-a",
        sessionFile: "sqlite:session-a",
        sessionId: "session-a",
        sessionKey: "agent:main:test",
        sessionTarget: {
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedWriterRunId: "run-a",
          sessionId: "session-a",
          sessionKey: "agent:main:test",
          storePath: "/tmp/openclaw.sqlite",
        },
      },
      externalAbortController,
    });

    expect(prepared.ownedTranscriptWriteContext.sessionTarget).toMatchObject({
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-a",
    });
    await expect(prepared.withOwnedTranscriptWrite(async () => "done")).resolves.toBe("done");
    expect(externalAbortController.arm).toHaveBeenCalledOnce();
    expect(externalAbortController.throwIfFiredAfterPrepCleanup).toHaveBeenCalledTimes(2);
    await prepared.transcriptLifecycle.dispose();
  });
});
