// Memory Wiki tests cover corpus supplement agent routing.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type MemoryWikiConfigResolver,
} from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";

const queryMocks = vi.hoisted(() => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
}));

vi.mock("./query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./query.js")>()),
  ...queryMocks,
}));

describe("memory-wiki corpus supplement", () => {
  const appConfig = {
    agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
  } as OpenClawConfig;
  const config = resolveMemoryWikiConfig({
    vault: { scope: "agent", path: "/tmp/memory-wiki-agents" },
  });

  beforeEach(() => {
    queryMocks.searchMemoryWiki.mockReset().mockResolvedValue([]);
    queryMocks.getMemoryWikiPage.mockReset().mockResolvedValue(null);
  });

  it("resolves search and get from each invocation's agent context", async () => {
    const resolveConfig = vi.fn<MemoryWikiConfigResolver>((agentId, currentAppConfig) =>
      resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
    );
    const getAppConfig = vi.fn(() => appConfig);
    const supplement = createWikiCorpusSupplement({ resolveConfig, getAppConfig });

    await supplement.search({
      query: "support handbook",
      maxResults: 4,
      agentId: "support",
      agentSessionKey: "agent:support:main",
      sandboxed: true,
    });
    await supplement.get({
      lookup: "marketing-plan",
      fromLine: 3,
      lineCount: 8,
      agentId: "marketing",
      agentSessionKey: "agent:marketing:main",
      sandboxed: false,
    });

    expect(resolveConfig).toHaveBeenNthCalledWith(1, "support", appConfig);
    expect(resolveConfig).toHaveBeenNthCalledWith(2, "marketing", appConfig);
    expect(queryMocks.searchMemoryWiki).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agentId: "support",
        vault: expect.objectContaining({
          path: path.join(config.vault.path, "support"),
        }),
      }),
      appConfig,
      agentId: "support",
      agentSessionKey: "agent:support:main",
      sandboxed: true,
      query: "support handbook",
      maxResults: 4,
      searchBackend: "local",
      searchCorpus: "wiki",
    });
    expect(queryMocks.getMemoryWikiPage).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agentId: "marketing",
        vault: expect.objectContaining({
          path: path.join(config.vault.path, "marketing"),
        }),
      }),
      appConfig,
      agentId: "marketing",
      agentSessionKey: "agent:marketing:main",
      sandboxed: false,
      lookup: "marketing-plan",
      fromLine: 3,
      lineCount: 8,
      searchBackend: "local",
      searchCorpus: "wiki",
    });
  });

  it("fails closed before querying when multi-agent context is missing", async () => {
    const supplement = createWikiCorpusSupplement({
      resolveConfig: (agentId, currentAppConfig) =>
        resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
      getAppConfig: () => appConfig,
    });

    await expect(supplement.search({ query: "shared data" })).rejects.toThrow(
      "agentId is required",
    );
    expect(queryMocks.searchMemoryWiki).not.toHaveBeenCalled();
  });
});
