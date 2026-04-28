import fs from "node:fs/promises";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  resolveMemoryWikiConfig,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { initializeMemoryWikiVault } from "./vault.js";

const MEMORY_WIKI_TEST_HOME = "/Users/tester";

export type MemoryWikiTestVault = {
  rootDir: string;
  config: ResolvedMemoryWikiConfig;
};

export type MemoryWikiPluginApiHarness = {
  api: OpenClawPluginApi;
  registerCli: ReturnType<typeof vi.fn>;
  registerGatewayMethod: ReturnType<typeof vi.fn>;
  registerMemoryCorpusSupplement: ReturnType<typeof vi.fn>;
  registerMemoryPromptSupplement: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
};

export function createMemoryWikiTestHarness() {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(prefix: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

  async function createVault(options?: {
    prefix?: string;
    rootDir?: string;
    config?: MemoryWikiPluginConfig;
    initialize?: boolean;
  }): Promise<MemoryWikiTestVault> {
    const rootDir =
      options?.rootDir ?? (await createTempDir(options?.prefix ?? "memory-wiki-test-"));
    const config = resolveMemoryWikiConfig(
      {
        ...options?.config,
        vault: {
          ...options?.config?.vault,
          path: rootDir,
        },
      },
      { homedir: MEMORY_WIKI_TEST_HOME },
    );

    if (options?.initialize) {
      await initializeMemoryWikiVault(config);
    }

    return { rootDir, config };
  }

  function createPluginApi(): MemoryWikiPluginApiHarness {
    const registerCli = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerMemoryCorpusSupplement = vi.fn();
    const registerMemoryPromptSupplement = vi.fn();
    const registerTool = vi.fn();
    const api = createTestPluginApi({
      id: "memory-wiki",
      name: "Memory Wiki",
      source: "test",
      config: {},
      runtime: {} as OpenClawPluginApi["runtime"],
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptSupplement,
      registerTool,
    });

    return {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptSupplement,
      registerTool,
    };
  }

  return {
    createPluginApi,
    createTempDir,
    createVault,
  };
}
