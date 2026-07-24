import { describe, expect, it, vi } from "vitest";
import { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

describe("createEmbeddedAttemptSessionLockController", () => {
  it("reloads SQLite transcript state after prompt-time writers finish", async () => {
    const reloadPromptReleasedSessionFile = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile,
    });

    await controller.reacquireAfterPrompt();

    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
  });
});
