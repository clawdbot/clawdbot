// Memory Core tests cover builtin search manager acquisition and cleanup.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const builtinManager = vi.hoisted(() => ({
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ status: "ok" as const, text: "", path: "MEMORY.md" })),
  status: vi.fn(() => ({ backend: "builtin" as const, provider: "openai" })),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
}));
const memoryIndexGet = vi.hoisted(() => vi.fn(async () => builtinManager));
const closeAllMemoryIndexManagers = vi.hoisted(() => vi.fn(async () => {}));
const closeMemoryIndexManagersForAgent = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../manager-runtime.js", () => ({
  MemoryIndexManager: { get: memoryIndexGet },
  closeAllMemoryIndexManagers,
  closeMemoryIndexManagersForAgent,
}));

import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./search-manager.js";

describe("builtin memory search manager", () => {
  beforeEach(() => {
    memoryIndexGet.mockClear();
    memoryIndexGet.mockResolvedValue(builtinManager);
    closeAllMemoryIndexManagers.mockClear();
    closeMemoryIndexManagersForAgent.mockClear();
  });

  it("returns the builtin manager for every purpose", async () => {
    const cfg = {} as OpenClawConfig;

    const result = await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" });

    expect(result.manager).toBe(builtinManager);
    expect(result.error).toBeUndefined();
    expect(result.debug).toMatchObject({ backend: "builtin", purpose: "status" });
    expect(result.debug?.managerMs).toBeGreaterThanOrEqual(0);
    expect(memoryIndexGet).toHaveBeenCalledWith({ cfg, agentId: "main", purpose: "status" });
  });

  it("returns the builtin initialization error", async () => {
    memoryIndexGet.mockRejectedValueOnce(new Error("index unavailable"));

    await expect(
      getMemorySearchManager({ cfg: {} as OpenClawConfig, agentId: "main" }),
    ).resolves.toMatchObject({ manager: null, error: "index unavailable" });
  });

  it("closes all loaded builtin managers", async () => {
    await getMemorySearchManager({ cfg: {} as OpenClawConfig, agentId: "main" });

    await closeAllMemorySearchManagers();

    expect(closeAllMemoryIndexManagers).toHaveBeenCalledOnce();
  });

  it("normalizes the agent id before scoped cleanup", async () => {
    const cfg = {} as OpenClawConfig;
    await getMemorySearchManager({ cfg, agentId: " Main " });

    await closeMemorySearchManager({ cfg, agentId: " Main " });

    expect(closeMemoryIndexManagersForAgent).toHaveBeenCalledWith({ agentId: "main" });
  });
});
