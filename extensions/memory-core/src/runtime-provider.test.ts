// Memory Core provider tests cover plugin runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it, vi } from "vitest";

const managerDebug = {
  backend: "qmd" as const,
  purpose: "default" as const,
  managerMs: 7,
  managerCacheState: "cached-full-hit" as const,
  qmdIdentityHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const getMemorySearchManagerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    manager: null,
    debug: managerDebug,
    error: undefined,
  })),
);

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: getMemorySearchManagerMock,
}));

import { createMemoryRuntime, memoryRuntime } from "./runtime-provider.js";

describe("memoryRuntime", () => {
  it("preserves manager debug metadata", async () => {
    const cfg = {} as OpenClawConfig;

    const result = await memoryRuntime.getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    expect(result.debug).toEqual(managerDebug);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
  });

  it("keeps local-service acquisition scoped to each runtime instance", async () => {
    const cfg = {} as OpenClawConfig;
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);

    await Promise.all([
      createMemoryRuntime(firstAcquire).getMemorySearchManager({ cfg, agentId: "first" }),
      createMemoryRuntime(secondAcquire).getMemorySearchManager({ cfg, agentId: "second" }),
    ]);

    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "first",
      acquireLocalService: firstAcquire,
    });
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "second",
      acquireLocalService: secondAcquire,
    });
  });
});
