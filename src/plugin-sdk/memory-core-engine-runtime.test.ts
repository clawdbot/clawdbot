/**
 * Tests memory core engine runtime facade behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortTermAuditIssue } from "./memory-core-engine-runtime.js";

const loadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const getMemorySearchManagerImpl = vi.hoisted(() => vi.fn(async () => ({ manager: null })));
const getMemoryIndexManagerImpl = vi.hoisted(() => vi.fn(async () => null));

vi.mock("./facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-runtime.js")>("./facade-runtime.js");
  return {
    ...actual,
    loadActivatedBundledPluginPublicSurfaceModuleSync,
  };
});

describe("memory-core engine runtime SDK facade", () => {
  beforeEach(() => {
    getMemorySearchManagerImpl.mockClear();
    getMemoryIndexManagerImpl.mockClear();
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReset().mockReturnValue({
      configureMemoryCoreDreamingState: vi.fn(),
      getMemorySearchManager: getMemorySearchManagerImpl,
      MemoryIndexManager: {
        get: getMemoryIndexManagerImpl,
      },
    });
  });

  it("exposes the short-term recall overflow audit code", () => {
    const issue = {
      severity: "warn",
      code: "recall-store-over-limit",
      message: "Short-term recall store is over the retention limit.",
      fixable: true,
    } satisfies ShortTermAuditIssue;

    expect(issue.code).toBe("recall-store-over-limit");
  });

  it("injects local-service acquisition and SQLite leases into manager facade calls", async () => {
    const runtime = await import("./memory-core-engine-runtime.js");
    const params = { cfg: {}, agentId: "main" } as never;

    await runtime.getMemorySearchManager(params);
    await runtime.MemoryIndexManager.get(params);

    expect(getMemorySearchManagerImpl).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      acquireLocalService: expect.any(Function),
      withLease: expect.any(Function),
    });
    expect(getMemoryIndexManagerImpl).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      acquireLocalService: expect.any(Function),
      withLease: expect.any(Function),
    });
  });
});
