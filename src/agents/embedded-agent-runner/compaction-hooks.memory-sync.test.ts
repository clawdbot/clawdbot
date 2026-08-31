/** Verifies a post-compaction memory sync that never runs is recorded, not silent. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveMemorySearchManagerCoreMock = vi.fn();
const resolveMemorySearchConfigMock = vi.fn();

vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore: (...args: unknown[]) =>
    getActiveMemorySearchManagerCoreMock(...args),
}));

vi.mock("../../memory-search.js", () => ({
  resolveMemorySearchConfig: (...args: unknown[]) => resolveMemorySearchConfigMock(...args),
}));

const { runPostCompactionSideEffects } = await import("./compaction-hooks.js");
const { log } = await import("./logger.js");

describe("post-compaction memory sync non-outcomes", () => {
  beforeEach(() => {
    getActiveMemorySearchManagerCoreMock.mockReset();
    resolveMemorySearchConfigMock.mockReset();
    vi.spyOn(log, "warn")
      .mockClear()
      .mockImplementation(() => {});
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: { sessions: { postCompactionForce: true } },
    });
  });

  it("records why the manager could not be acquired before the sync", async () => {
    getActiveMemorySearchManagerCoreMock.mockResolvedValue({
      manager: null,
      error: "embedding provider unavailable",
    });

    await runPostCompactionSideEffects({
      config: { agents: { defaults: { compaction: { postIndexSync: "await" } } } } as never,
      sessionId: "s1",
      agentId: "main",
      sessionFile: "/tmp/session.jsonl",
    });

    expect(getActiveMemorySearchManagerCoreMock).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      "memory sync skipped (post-compaction): embedding provider unavailable",
    );
  });

  it("stays silent when the manager exists but exposes no sync", async () => {
    getActiveMemorySearchManagerCoreMock.mockResolvedValue({ manager: {} });

    await runPostCompactionSideEffects({
      config: { agents: { defaults: { compaction: { postIndexSync: "await" } } } } as never,
      sessionId: "s1",
      agentId: "main",
      sessionFile: "/tmp/session.jsonl",
    });

    expect(getActiveMemorySearchManagerCoreMock).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
