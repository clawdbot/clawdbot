// Memory Wiki tests cover agent-scoped vault isolation through the public tools.
import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import memoryCorePlugin from "../../memory-core/index.js";
import type { OpenClawConfig } from "../api.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiGetTool, createWikiSearchTool } from "./tool.js";

const { createTempDir } = createMemoryWikiTestHarness();

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected tool details object");
  }
  return value as Record<string, unknown>;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function registerMemoryCoreToolFactories(
  appConfig: OpenClawConfig,
): Map<string, OpenClawPluginToolFactory> {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  memoryCorePlugin.register(
    createTestPluginApi({
      id: "memory-core",
      config: appConfig,
      runtime: createPluginRuntimeMock(),
      registerTool(tool, options) {
        if (typeof tool !== "function") {
          return;
        }
        for (const name of options?.names ?? []) {
          factories.set(name, tool);
        }
      },
    }),
  );
  return factories;
}

function createMemoryCoreTool(params: {
  factories: Map<string, OpenClawPluginToolFactory>;
  name: "memory_search" | "memory_get";
  appConfig: OpenClawConfig;
  agentId: string;
}): AnyAgentTool {
  const factory = params.factories.get(params.name);
  if (!factory) {
    throw new Error(`Expected memory-core to register ${params.name}`);
  }
  const tool = factory({
    config: params.appConfig,
    runtimeConfig: params.appConfig,
    getRuntimeConfig: () => params.appConfig,
    agentId: params.agentId,
    sessionKey: `agent:${params.agentId}:main`,
  });
  if (!tool || Array.isArray(tool)) {
    throw new Error(`Expected one ${params.name} tool`);
  }
  return tool;
}

describe("agent-scoped memory-wiki tools", () => {
  it("keeps apply, search, and get behavior isolated by configured agent", async () => {
    const vaultParent = await createTempDir("memory-wiki-agent-vaults-");
    const appConfig = {
      agents: {
        list: [{ id: "support", default: true }, { id: "marketing" }],
      },
    } as OpenClawConfig;
    const baseConfig = resolveMemoryWikiConfig({
      vault: { scope: "agent", path: vaultParent },
      search: { backend: "local", corpus: "wiki" },
    });

    const agents: Array<{
      id: string;
      title: string;
      sentinel: string;
      config: ResolvedMemoryWikiConfig;
      pagePath?: string;
    }> = [
      {
        id: "support",
        title: "Support Private Synthesis",
        sentinel: "SUPPORT_ONLY_7f3c21",
        config: resolveMemoryWikiAgentConfig({
          config: baseConfig,
          appConfig,
          agentId: "support",
        }),
      },
      {
        id: "marketing",
        title: "Marketing Private Synthesis",
        sentinel: "MARKETING_ONLY_8e4d62",
        config: resolveMemoryWikiAgentConfig({
          config: baseConfig,
          appConfig,
          agentId: "marketing",
        }),
      },
    ];

    for (const agent of agents) {
      const result = await createWikiApplyTool(agent.config, appConfig).execute(
        `apply-${agent.id}`,
        {
          op: "create_synthesis",
          title: agent.title,
          body: `Private synthesis marker: ${agent.sentinel}`,
          sourceIds: [`source.${agent.id}`],
        },
      );
      const pagePath = asRecord(result.details).pagePath;
      if (typeof pagePath !== "string") {
        throw new Error("Expected wiki_apply to return pagePath");
      }
      agent.pagePath = pagePath;
    }

    expect(agents[0]?.config.vault.path).toBe(path.join(vaultParent, "support"));
    expect(agents[1]?.config.vault.path).toBe(path.join(vaultParent, "marketing"));
    expect(agents[0]?.config.vault.path).not.toBe(agents[1]?.config.vault.path);

    for (const agent of agents) {
      const foreignAgent = agents.find((candidate) => candidate.id !== agent.id);
      if (!agent.pagePath || !foreignAgent?.pagePath) {
        throw new Error("Expected both agent synthesis paths");
      }

      expect((await fs.stat(agent.config.vault.path)).isDirectory()).toBe(true);
      await expect(
        fs.readFile(path.join(agent.config.vault.path, agent.pagePath), "utf8"),
      ).resolves.toContain(agent.sentinel);
      await expect(
        fs.access(path.join(agent.config.vault.path, foreignAgent.pagePath)),
      ).rejects.toThrow();

      const searchTool = createWikiSearchTool(agent.config, appConfig, {
        agentId: agent.id,
      });
      const ownSearch = await searchTool.execute(`search-own-${agent.id}`, {
        query: agent.sentinel,
      });
      expect(textContent(ownSearch)).toContain(agent.sentinel);
      expect(asRecord(ownSearch.details).results).toEqual([
        expect.objectContaining({ path: agent.pagePath }),
      ]);

      const foreignSearch = await searchTool.execute(`search-foreign-${agent.id}`, {
        query: foreignAgent.sentinel,
      });
      expect(textContent(foreignSearch)).toBe("No wiki or memory results.");
      expect(asRecord(foreignSearch.details).results).toEqual([]);

      const getTool = createWikiGetTool(agent.config, appConfig, { agentId: agent.id });
      const ownGet = await getTool.execute(`get-own-${agent.id}`, { lookup: agent.pagePath });
      expect(textContent(ownGet)).toContain(agent.sentinel);
      expect(asRecord(ownGet.details).found).toBe(true);

      const foreignGet = await getTool.execute(`get-foreign-${agent.id}`, {
        lookup: foreignAgent.pagePath,
      });
      expect(textContent(foreignGet)).toBe(`Wiki page not found: ${foreignAgent.pagePath}`);
      expect(asRecord(foreignGet.details).found).toBe(false);
    }

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement(
        "memory-wiki",
        createWikiCorpusSupplement({
          resolveConfig: (agentId, currentAppConfig) =>
            resolveMemoryWikiAgentConfig({
              config: baseConfig,
              appConfig: currentAppConfig,
              agentId,
            }),
          getAppConfig: () => appConfig,
        }),
      );
      const memoryCoreFactories = registerMemoryCoreToolFactories(appConfig);

      for (const agent of agents) {
        const foreignAgent = agents.find((candidate) => candidate.id !== agent.id);
        if (!agent.pagePath || !foreignAgent?.pagePath) {
          throw new Error("Expected both agent synthesis paths");
        }

        const memorySearch = createMemoryCoreTool({
          factories: memoryCoreFactories,
          name: "memory_search",
          appConfig,
          agentId: agent.id,
        });
        const ownMemorySearch = await memorySearch.execute(`memory-search-own-${agent.id}`, {
          query: agent.sentinel,
          corpus: "wiki",
        });
        expect(asRecord(ownMemorySearch.details).results).toEqual([
          expect.objectContaining({
            corpus: "wiki",
            path: agent.pagePath,
            snippet: expect.stringContaining(agent.sentinel),
          }),
        ]);

        const foreignMemorySearch = await memorySearch.execute(
          `memory-search-foreign-${agent.id}`,
          {
            query: foreignAgent.sentinel,
            corpus: "wiki",
          },
        );
        expect(asRecord(foreignMemorySearch.details).results).toEqual([]);

        const memoryGet = createMemoryCoreTool({
          factories: memoryCoreFactories,
          name: "memory_get",
          appConfig,
          agentId: agent.id,
        });
        const ownMemoryGet = await memoryGet.execute(`memory-get-own-${agent.id}`, {
          path: agent.pagePath,
          corpus: "wiki",
        });
        expect(asRecord(ownMemoryGet.details)).toMatchObject({
          corpus: "wiki",
          path: agent.pagePath,
          text: expect.stringContaining(agent.sentinel),
        });

        const foreignMemoryGet = await memoryGet.execute(`memory-get-foreign-${agent.id}`, {
          path: foreignAgent.pagePath,
          corpus: "wiki",
        });
        expect(asRecord(foreignMemoryGet.details)).toMatchObject({
          path: foreignAgent.pagePath,
          text: "",
          disabled: true,
          error: "wiki corpus result not found",
        });
      }
    } finally {
      clearMemoryPluginState();
    }
  }, 240_000);
});
