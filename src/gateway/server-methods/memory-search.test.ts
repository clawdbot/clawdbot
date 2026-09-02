import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemoryProviderStatus, MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const getActiveMemorySearchManagerCore = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));

vi.mock("../../plugins/memory-runtime.js", () => ({ getActiveMemorySearchManagerCore }));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveDefaultAgentId,
}));

import { memorySearchHandlers } from "./memory-search.js";

let testState: OpenClawTestState;

function createConfig(workspaceDir: string): OpenClawConfig {
  return {
    memory: {
      search: {
        provider: "none",
        query: { minScore: 0 },
      },
    },
    agents: {
      defaults: { workspace: workspaceDir },
      list: [{ id: "main", default: true }],
    },
  };
}

async function invokeMemorySearch(params: unknown, cfg: OpenClawConfig) {
  const respond = vi.fn();
  await expectDefined(
    memorySearchHandlers["memory.search"],
    'memorySearchHandlers["memory.search"] test invariant',
  )({
    req: { id: "memory-search-test" } as never,
    params: params as never,
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function createStubManager() {
  return {
    search: vi.fn(async (): Promise<MemorySearchResult[]> => []),
    status: vi.fn(
      (): MemoryProviderStatus => ({
        backend: "builtin" as const,
        provider: "none",
        dirty: false,
        custom: { searchMode: "fts-only" },
      }),
    ),
    close: vi.fn(async () => undefined),
  };
}

describe("memory.search gateway method", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "gateway-memory-search",
      layout: "state-only",
    });
    getActiveMemorySearchManagerCore.mockReset();
    resolveDefaultAgentId.mockClear();
  });

  afterEach(async () => {
    await testState.cleanup();
  });

  it("rejects a missing or whitespace-only query before acquiring a manager", async () => {
    const cfg = createConfig(testState.workspaceDir);

    for (const params of [{}, { query: "   " }]) {
      const respond = await invokeMemorySearch(params, cfg);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "query must be a non-empty string",
        }),
      );
    }
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it.each([
    { requested: 100, expected: 50 },
    { requested: 0, expected: 1 },
  ])("clamps maxResults=$requested to $expected", async ({ requested, expected }) => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    await invokeMemorySearch({ query: "lantern", maxResults: requested, minScore: 0.42 }, cfg);

    expect(manager.search).toHaveBeenCalledWith("lantern", {
      maxResults: expected,
      minScore: 0.42,
    });
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it("rejects an unknown agentId without acquiring a manager", async () => {
    const cfg = createConfig(testState.workspaceDir);

    const respond = await invokeMemorySearch({ query: "lantern", agentId: "invented" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown agentId",
      }),
    );
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("returns typed selection-required when an explicit fleet omits agentId", async () => {
    const cfg = createConfig(testState.workspaceDir);
    cfg.agents = {
      ...cfg.agents,
      ownership: "explicit",
      list: [{ id: "ops" }, { id: "research" }],
    };
    resolveDefaultAgentId.mockImplementationOnce(() => {
      throw new AgentSelectionRequiredError(["ops", "research"], {
        surface: "memory search",
        hint: "Pass agentId to select a configured agent.",
      });
    });

    const respond = await invokeMemorySearch({ query: "lantern" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("rejects a non-string agentId without acquiring a manager", async () => {
    const cfg = createConfig(testState.workspaceDir);

    const respond = await invokeMemorySearch({ query: "lantern", agentId: 42 }, cfg);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agentId must be a string",
      }),
    );
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it.each(["   ", "---", "ſ"])(
    "rejects a normalization-empty agentId without acquiring a manager: %j",
    async (agentId) => {
      const cfg = createConfig(testState.workspaceDir);

      const respond = await invokeMemorySearch({ query: "lantern", agentId }, cfg);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "unknown agentId",
        }),
      );
      expect(resolveDefaultAgentId).not.toHaveBeenCalled();
      expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
    },
  );

  it.each([
    { configured: "research", requested: "Research" },
    { configured: "_", requested: "_" },
  ])("searches configured non-default agent $configured", async ({ configured, requested }) => {
    const cfg = createConfig(testState.workspaceDir);
    cfg.agents = {
      ...cfg.agents,
      list: [{ id: "main", default: true }, { id: configured }],
    };
    const result = {
      path: "memory/project-lantern.md",
      startLine: 2,
      endLine: 2,
      score: 0.75,
      snippet: "The launch window opens at sunrise.",
      source: "memory" as const,
    };
    const manager = createStubManager();
    manager.search.mockResolvedValue([result]);
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "lantern", agentId: requested }, cfg);

    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledWith({
      cfg,
      agentId: configured,
      purpose: "cli",
    });
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: configured,
        provider: "none",
        searchMode: "fts-only",
        results: [result],
      },
      undefined,
    );
  });

  it("returns unavailable when no memory manager is configured", async () => {
    const cfg: OpenClawConfig = {};
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: null,
      error: "memory plugin unavailable",
    });

    const respond = await invokeMemorySearch({ query: "lantern" }, cfg);

    expect(resolveDefaultAgentId).toHaveBeenCalledWith(cfg, {
      surface: "memory search",
      hint: "Pass agentId to select a configured agent.",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "memory plugin unavailable",
      }),
    );
  });

  it("does not qualify routine pending index work as a search failure", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: true,
      custom: { searchMode: "fts-only" },
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "hidden codeword" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
      },
      undefined,
    );
  });

  it("qualifies results after automatic indexing fails", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: true,
      lastSyncError: "embedding request timed out",
      custom: { searchMode: "fts-only" },
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "hidden codeword" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
        stale: true,
        warning:
          "Memory index is stale: embedding request timed out. Search results may be incomplete.",
        action: "Run: openclaw memory status --index --agent main",
      },
      undefined,
    );
  });
});
