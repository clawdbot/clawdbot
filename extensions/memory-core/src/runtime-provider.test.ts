// Memory Core provider tests cover plugin runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it, vi } from "vitest";

const managerDebug = {
  backend: "builtin" as const,
  purpose: "default" as const,
  managerMs: 7,
};

const getMemorySearchManagerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    manager: null,
    debug: managerDebug,
    error: undefined,
  })),
);
const filterMemorySearchHitsBySessionVisibilityMock = vi.hoisted(() => vi.fn());
const configureMemoryCoreDreamingStateMock = vi.hoisted(() => vi.fn());

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("./session-search-visibility.js", () => ({
  filterMemorySearchHitsBySessionVisibility: filterMemorySearchHitsBySessionVisibilityMock,
}));

vi.mock("./dreaming-state.js", () => ({
  configureMemoryCoreDreamingState: configureMemoryCoreDreamingStateMock,
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
      createMemoryRuntime({ acquireLocalService: firstAcquire }).getMemorySearchManager({
        cfg,
        agentId: "first",
      }),
      createMemoryRuntime({ acquireLocalService: secondAcquire }).getMemorySearchManager({
        cfg,
        agentId: "second",
      }),
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

  it("binds the scoped state opener inside each lazy runtime instance", async () => {
    const cfg = {} as OpenClawConfig;
    const openKeyedStore = vi.fn();
    configureMemoryCoreDreamingStateMock.mockClear();

    await createMemoryRuntime({ openKeyedStore }).getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    expect(configureMemoryCoreDreamingStateMock).toHaveBeenCalledWith(openKeyedStore);
  });

  it("delegates raw-hit authorization to the canonical session visibility filter", async () => {
    const cfg = {} as OpenClawConfig;
    const hits: MemorySearchResult[] = [
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];
    filterMemorySearchHitsBySessionVisibilityMock.mockResolvedValue([]);
    if (!memoryRuntime.authorizeSearchHits) {
      throw new Error("memory runtime search authorizer is unavailable");
    }

    await expect(
      memoryRuntime.authorizeSearchHits({
        cfg,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([]);
    expect(filterMemorySearchHitsBySessionVisibilityMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    });
  });
});
