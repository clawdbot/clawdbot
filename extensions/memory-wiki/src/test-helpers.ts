// Memory Wiki helper module supports test helpers behavior.
import type {
  OpenKeyedStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
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

// A reject-new store capped at `cap` rows: mirrors the real store's
// PLUGIN_STATE_LIMIT_EXCEEDED contract without seeding 20,000 rows.
export function createCapacityCappedKeyedStore(cap: number) {
  const limit = { cap };
  const values = new Map<string, unknown>();
  const openKeyedStore = <T>(_options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => ({
    async register(key, value) {
      if (!values.has(key) && values.size >= limit.cap) {
        throw Object.assign(new Error("namespace row limit reached"), {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        });
      }
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      if (values.size >= cap) {
        throw Object.assign(new Error("namespace row limit reached"), {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        });
      }
      values.set(key, value);
      return true;
    },
    async lookup(key) {
      return values.get(key) as T | undefined;
    },
    async consume(key) {
      const value = values.get(key) as T | undefined;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({
        key,
        value: value as T,
        createdAt: 0,
      }));
    },
    async clear() {
      values.clear();
    },
  });
  return {
    openKeyedStore,
    values,
    setCap(next: number) {
      limit.cap = next;
    },
  };
}

export function createMemoryWikiTestHarness() {
  const tempWorkspaces: TempWorkspace[] = [];
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
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  // openclaw-temp-dir: allow this shared harness couples workspace cleanup to cache and vault lifecycle.
  async function createTempDir(prefix: string): Promise<string> {
    configureCompiledCacheStore();
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix,
    });
    tempWorkspaces.push(workspace);
    return workspace.dir;
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
