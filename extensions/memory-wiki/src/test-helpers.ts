// Memory Wiki helper module supports test helpers behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
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

type MemoryWikiTestVault = {
  rootDir: string;
  config: ResolvedMemoryWikiConfig;
};

type MemoryWikiPluginApiHarness = {
  api: OpenClawPluginApi;
  registerCli: ReturnType<typeof vi.fn>;
  registerGatewayMethod: ReturnType<typeof vi.fn>;
  registerMemoryCorpusSupplement: ReturnType<typeof vi.fn>;
  registerMemoryPromptSupplement: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
};

function createMemoryKeyedStore<T>() {
  const values = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      values.set(key, value);
    },
    async registerIfAbsent(key: string, value: T) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async lookup(key: string) {
      return values.get(key);
    },
    async consume(key: string) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(
        ([key, value]) =>
          ({
            key,
            value,
            createdAt: 0,
          }) satisfies PluginStateEntry<T>,
      );
    },
    async clear() {
      values.clear();
    },
  };
}

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
      runtime: {
        state: {
          openKeyedStore: vi.fn(<T>() => createMemoryKeyedStore<T>()),
        },
      } as unknown as OpenClawPluginApi["runtime"],
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
