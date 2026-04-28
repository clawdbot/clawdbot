import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as embeddedRunTesting,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "../agents/pi-embedded-runner/runs.js";
import { __testing } from "./server-reload-handlers.js";

describe("gateway reload recovery handlers", () => {
  afterEach(() => {
    embeddedRunTesting.resetActiveEmbeddedRuns();
  });

  it("aborts active agent runs after last-known-good config recovery", () => {
    const sessionId = "config-recovery-session";
    const sessionKey = "agent:main:telegram:direct:123";
    let handle!: EmbeddedPiQueueHandle;
    handle = {
      abort: vi.fn(() => {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }),
      isCompacting: () => false,
      isStreaming: () => false,
      queueMessage: async () => {},
    };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    __testing.abortActiveAgentRunsAfterConfigRecovery({
      reason: "invalid-config",
      logReload,
    });

    expect(handle.abort).toHaveBeenCalledOnce();
    expect(logReload.warn).toHaveBeenCalledWith(
      "config recovery aborted active agent run(s) after reload-invalid-config",
    );
  });

  it("does not warn when config recovery has no active agent runs to abort", () => {
    const logReload = { info: vi.fn(), warn: vi.fn() };

    __testing.abortActiveAgentRunsAfterConfigRecovery({
      reason: "invalid-config",
      logReload,
    });

    expect(logReload.warn).not.toHaveBeenCalled();
  });
});
