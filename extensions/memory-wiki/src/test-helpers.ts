// Memory Wiki helper module supports test helpers behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
  PluginStateEntry,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
} from "./compiled-cache.js";
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
  registerMemoryPromptPreparation: ReturnType<typeof vi.fn>;
  registerMemoryPromptSupplement: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn>;
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

function createMemoryBlobStore<T>() {
  const values = new Map<string, PluginBlobEntry<T>>();
  const register = async (
    key: string,
    bytes: Uint8Array,
    metadata: T,
    opts?: { ttlMs?: number },
  ) => {
    values.set(key, {
      key,
      bytes,
      metadata,
      sizeBytes: bytes.byteLength,
      createdAt: Date.now(),
      ...(opts?.ttlMs ? { expiresAt: Date.now() + opts.ttlMs } : {}),
    });
  };
  return {
    register,
    async registerIfAbsent(key: string, bytes: Uint8Array, metadata: T, opts?: { ttlMs?: number }) {
      if (values.has(key)) {
        return false;
      }
      await register(key, bytes, metadata, opts);
      return true;
    },
    async lookup(key: string) {
      return values.get(key);
    },
    async entries() {
      return [...values.values()].map(({ bytes: _bytes, ...entry }) => entry);
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async deleteExpiredKey(key: string) {
      const entry = values.get(key);
      if (!entry?.expiresAt || entry.expiresAt > Date.now()) {
        return undefined;
      }
      values.delete(key);
      const { bytes: _bytes, ...info } = entry;
      return info;
    },
    async deleteExpired() {
      const expired: PluginBlobEntryInfo<T>[] = [];
      for (const key of values.keys()) {
        const entry = values.get(key);
        if (!entry?.expiresAt || entry.expiresAt > Date.now()) {
          continue;
        }
        values.delete(key);
        const { bytes: _bytes, ...info } = entry;
        expired.push(info);
      }
      return expired;
    },
    async clear() {
      values.clear();
    },
  };
}

export function createMemoryWikiTestHarness() {
  const tempDirs: string[] = [];
  let compiledBlobStore = createMemoryBlobStore<unknown>();

  function configureCompiledCacheStore(): void {
    configureMemoryWikiCompiledCacheStore(
      createMemoryWikiCompiledCacheStore(
        <T>() => compiledBlobStore as unknown as PluginBlobStore<T>,
      ),
    );
  }

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    compiledBlobStore = createMemoryBlobStore<unknown>();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(prefix: string): Promise<string> {
    configureCompiledCacheStore();
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
    configureCompiledCacheStore();
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
    const registerMemoryPromptPreparation = vi.fn();
    const registerMemoryPromptSupplement = vi.fn();
    const registerService = vi.fn();
    const registerTool = vi.fn();
    const api = createTestPluginApi({
      id: "memory-wiki",
      name: "Memory Wiki",
      source: "test",
      config: {},
      runtime: {
        state: {
          openKeyedStore: vi.fn(<T>() => createMemoryKeyedStore<T>()),
          openBlobStore: vi.fn(<T>() => createMemoryBlobStore<T>()),
        },
      } as unknown as OpenClawPluginApi["runtime"],
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptPreparation,
      registerMemoryPromptSupplement,
      registerService,
      registerTool,
    });

    return {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptPreparation,
      registerMemoryPromptSupplement,
      registerService,
      registerTool,
    };
  }

  return {
    configureCompiledCacheStore,
    createPluginApi,
    createTempDir,
    createVault,
  };
}
