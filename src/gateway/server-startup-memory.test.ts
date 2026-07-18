/**
 * Gateway startup memory-service tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryQmdUpdateConfig } from "../config/types.memory.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";

const { getMemorySearchManagerMock, resolveMemorySearchConfigMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
  resolveMemorySearchConfigMock: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
}));

// This suite owns startup orchestration; agent and memory config resolution have
// separate tests. Keep those graphs out of this non-isolated Gateway shard.
vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: (cfg: OpenClawConfig) => cfg.agents?.list ?? [],
  listAgentIds: (cfg: OpenClawConfig) => cfg.agents?.list?.map((entry) => entry.id) ?? ["main"],
  resolveDefaultAgentId: (cfg: OpenClawConfig) =>
    cfg.agents?.list?.find((entry) => entry.default)?.id ?? "main",
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: resolveMemorySearchConfigMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createQmdConfig(
  agents: OpenClawConfig["agents"],
  update: MemoryQmdUpdateConfig = { startup: "immediate" },
): OpenClawConfig {
  return {
    agents,
    memory: { backend: "qmd", qmd: { update } },
  } as OpenClawConfig;
}

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createQmdManagerMock() {
  return {
    search: vi.fn(),
    sync: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function startMemoryBackendForTest(cfg: OpenClawConfig) {
  const log = createGatewayLogMock();
  await startGatewayMemoryBackend({ cfg, log });
  return log;
}

async function startQmdBackendWithManager(cfg: OpenClawConfig) {
  getMemorySearchManagerMock.mockResolvedValue({ manager: createQmdManagerMock() });
  return await startMemoryBackendForTest(cfg);
}

function expectNoMemoryBackendStartup(log: ReturnType<typeof createGatewayLogMock>) {
  expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
}

function expectQmdManagerRequests(cfg: OpenClawConfig, agentIds: string[]) {
  expectQmdManagerRequestsWithPurpose(cfg, agentIds, "cli");
}

function expectQmdManagerRequestsWithPurpose(
  cfg: OpenClawConfig,
  agentIds: string[],
  purpose: "cli" | "default",
) {
  expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(agentIds.length);
  for (const [index, agentId] of agentIds.entries()) {
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(index + 1, {
      cfg,
      agentId,
      purpose,
    });
  }
}

function expectBootSyncCompleted(
  log: ReturnType<typeof createGatewayLogMock>,
  count: number,
  agents: string,
) {
  const noun = count === 1 ? "agent" : "agents";
  expect(log.info).toHaveBeenCalledWith(
    `qmd memory startup boot sync completed for ${count} ${noun}: ${agents}`,
  );
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
    resolveMemorySearchConfigMock.mockReset();
    resolveMemorySearchConfigMock.mockImplementation((cfg: OpenClawConfig, agentId: string) => {
      const agent = cfg.agents?.list?.find((entry) => entry.id === agentId);
      const enabled =
        agent?.memorySearch?.enabled ?? cfg.agents?.defaults?.memorySearch?.enabled ?? true;
      return enabled ? {} : null;
    });
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "builtin" },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("keeps qmd managers lazy when startup refresh is not opted in", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("runs qmd boot sync for the default and explicitly configured agents", async () => {
    const cfg = createQmdConfig(
      {
        list: [
          { id: "ops", default: true },
          { id: "main", memorySearch: { enabled: true } },
          { id: "lazy" },
        ],
      },
      { startup: "immediate", interval: "0s", embedInterval: "0s" },
    );

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["ops", "main"]);
    expectBootSyncCompleted(log, 2, '"ops", "main"');
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization deferred for 1 agent: "lazy"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes all qmd agents when memory search is explicitly enabled in defaults", async () => {
    const cfg = createQmdConfig(
      {
        defaults: { memorySearch: { enabled: true } },
        list: [{ id: "ops", default: true }, { id: "main" }],
      },
      { startup: "immediate", interval: "0s", embedInterval: "0s" },
    );

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["ops", "main"]);
    expectBootSyncCompleted(log, 2, '"ops", "main"');
    expect(log.info.mock.calls.some(([message]) => String(message).includes("deferred"))).toBe(
      false,
    );
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = createQmdConfig(
      {
        list: [
          { id: "main", default: true },
          { id: "ops", memorySearch: { enabled: true } },
        ],
      },
      { startup: "immediate", interval: "0s", embedInterval: "0s" },
    );
    const log = createGatewayLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expectBootSyncCompleted(log, 1, '"ops"');
  });

  it("skips an unavailable memory owner and initializes healthy agents", async () => {
    const cfg = createQmdConfig(
      {
        defaults: { memorySearch: { enabled: true } },
        list: [{ id: "cold", default: true }, { id: "healthy" }],
      },
      { startup: "immediate", interval: "0s", embedInterval: "0s" },
    );
    resolveMemorySearchConfigMock.mockImplementation((_cfg: OpenClawConfig, agentId: string) => {
      if (agentId === "cold") {
        throw new SecretSurfaceUnavailableError({
          ownerKind: "capability",
          ownerId: "memory-provider:cold",
          state: "unavailable",
          paths: ["agents.defaults.memorySearch.remote.apiKey"],
          refKeys: ["env:default:MISSING_MEMORY_KEY"],
          reason: "secret reference was not found",
        });
      }
      return {};
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["healthy"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory startup unavailable for agent "cold"'),
    );
    expectBootSyncCompleted(log, 1, '"healthy"');
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = createQmdConfig(
      {
        defaults: { memorySearch: { enabled: true } },
        list: [
          { id: "main", default: true },
          { id: "ops", memorySearch: { enabled: false } },
        ],
      },
      { startup: "immediate", interval: "0s", embedInterval: "0s" },
    );

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["main"]);
    expectBootSyncCompleted(log, 1, '"main"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not initialize qmd managers when background work is disabled", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "qmd",
        qmd: {
          update: { startup: "immediate", onBoot: false, interval: "0s", embedInterval: "0s" },
        },
      },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("keeps the full qmd manager alive for startup interval maintenance", async () => {
    const manager = createQmdManagerMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager });
    const cfg = createQmdConfig(
      { list: [{ id: "main", default: true }] },
      { startup: "immediate", onBoot: false, interval: "5m", embedInterval: "0s" },
    );

    const log = await startMemoryBackendForTest(cfg);

    expectQmdManagerRequestsWithPurpose(cfg, ["main"], "default");
    expect(manager.sync).not.toHaveBeenCalled();
    expect(manager.close).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup manager initialized for 1 agent: "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not manually boot sync full qmd managers that own their startup update", async () => {
    const manager = createQmdManagerMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager });
    const cfg = createQmdConfig(
      { list: [{ id: "main", default: true }] },
      { startup: "immediate", onBoot: true, interval: "5m", embedInterval: "0s" },
    );

    const log = await startMemoryBackendForTest(cfg);

    expectQmdManagerRequestsWithPurpose(cfg, ["main"], "default");
    expect(manager.sync).not.toHaveBeenCalled();
    expect(manager.close).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup manager initialized for 1 agent: "main"',
    );
  });
});
