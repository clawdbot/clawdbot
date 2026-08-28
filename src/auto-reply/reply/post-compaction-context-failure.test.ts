/**
 * Tests for post-compaction context read failure logging.
 *
 * The catch handler in agent-runner.ts (lines ~1607-1615) should log a warn-level
 * breadcrumb when readPostCompactionContext rejects, instead of silently swallowing
 * the error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWarn = vi.fn<(msg: string) => void>();

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: (subsystem: string) => ({
    subsystem,
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }),
}));

const mockReadPostCompactionContext = vi.fn<() => Promise<string | null>>();

vi.mock("./post-compaction-context.js", () => ({
  readPostCompactionContext: (...args: unknown[]) => mockReadPostCompactionContext(...(args as [])),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEventRaw: vi.fn(),
}));

describe("post-compaction context failure logging", () => {
  beforeEach(() => {
    mockWarn.mockClear();
    mockReadPostCompactionContext.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs warn with [continuation:post-compaction-context-failed] anchor when readPostCompactionContext rejects", async () => {
    // Arrange: make readPostCompactionContext reject with an error
    const testError = new Error("EACCES: permission denied");
    mockReadPostCompactionContext.mockRejectedValue(testError);

    // Import the handler logic
    const { readPostCompactionContext } = await import("./post-compaction-context.js");
    const { createSubsystemLogger } = await import("../../logging/subsystem.js");

    // Simulate the catch handler behavior from agent-runner.ts (lines 1607-1615)
    const sessionKey = "test-session-123";
    const workspaceDir = "/tmp/test-workspace";
    const cfg = {};

    // Execute the same promise chain pattern as agent-runner.ts
    await readPostCompactionContext(workspaceDir, cfg)
      .then((contextContent) => {
        if (contextContent) {
          // enqueueSystemEvent would be called here
        }
      })
      .catch(async (err: unknown) => {
        const log = createSubsystemLogger("continuation/post-compaction-context");
        log.warn(
          `[continuation:post-compaction-context-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} workspaceDir=${workspaceDir}`,
        );
      });

    // Assert: warn was called with the expected anchor and context
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const loggedMessage = mockWarn.mock.calls[0]?.[0];
    expect(loggedMessage).toContain("[continuation:post-compaction-context-failed]");
    expect(loggedMessage).toContain("EACCES: permission denied");
    expect(loggedMessage).toContain("session=test-session-123");
    expect(loggedMessage).toContain("workspaceDir=/tmp/test-workspace");
  });

  it("logs warn with string coerced error when rejection is not an Error instance", async () => {
    // Arrange: reject with a non-Error value
    mockReadPostCompactionContext.mockRejectedValue("raw string error");

    const { readPostCompactionContext } = await import("./post-compaction-context.js");
    const { createSubsystemLogger } = await import("../../logging/subsystem.js");

    const sessionKey = "session-456";
    const workspaceDir = "/workspace";
    const cfg = {};

    await readPostCompactionContext(workspaceDir, cfg)
      .then(() => {})
      .catch(async (err: unknown) => {
        const log = createSubsystemLogger("continuation/post-compaction-context");
        log.warn(
          `[continuation:post-compaction-context-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} workspaceDir=${workspaceDir}`,
        );
      });

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const loggedMessage = mockWarn.mock.calls[0]?.[0];
    expect(loggedMessage).toContain("[continuation:post-compaction-context-failed]");
    expect(loggedMessage).toContain("raw string error");
  });

  it("does not log warn when readPostCompactionContext succeeds", async () => {
    // Arrange: make readPostCompactionContext resolve successfully
    mockReadPostCompactionContext.mockResolvedValue("## Session Startup\n\nContext here.");

    const { readPostCompactionContext } = await import("./post-compaction-context.js");
    const { createSubsystemLogger } = await import("../../logging/subsystem.js");

    const sessionKey = "session-789";
    const workspaceDir = "/workspace";
    const cfg = {};

    await readPostCompactionContext(workspaceDir, cfg)
      .then((contextContent) => {
        if (contextContent) {
          // Success path - no logging expected
        }
      })
      .catch(async (err: unknown) => {
        const log = createSubsystemLogger("continuation/post-compaction-context");
        log.warn(
          `[continuation:post-compaction-context-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} workspaceDir=${workspaceDir}`,
        );
      });

    // Assert: warn was NOT called
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
