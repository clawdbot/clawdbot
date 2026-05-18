import { expectChannelPluginContract } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeAll, describe, it } from "vitest";
import { getBundledChannelPluginAsync } from "./bundled-channel-plugin-loader.js";
import { channelPluginSurfaceKeys } from "./manifest.js";
import { getPluginContractRegistryShardRefs } from "./registry-plugin.js";
import {
  getDirectoryContractRegistryShardRefs,
  getSurfaceContractRegistryShardIds,
  getThreadingContractRegistryShardRefs,
} from "./surface-contract-registry.js";
import { expectChannelSurfaceContract } from "./surface-contract-suite.js";
import {
  expectChannelDirectoryBaseContract,
  expectChannelThreadingBaseContract,
  expectChannelThreadingReturnValuesNormalized,
} from "./threading-directory-contract-suites.js";

type ContractShardParams = {
  shardIndex: number;
  shardCount: number;
};

function installEmptyShardSuite(label: string) {
  describe(label, () => {
    it("has no matching bundled channels", () => {
      // Keeps intentionally empty id-based shards visible to Vitest.
    });
  });
}

export function installSurfaceContractRegistryShard(params: ContractShardParams) {
  const ids = getSurfaceContractRegistryShardIds(params);
  if (ids.length === 0) {
    installEmptyShardSuite("surface contract registry shard");
    return;
  }

  for (const id of ids) {
    describe(`${id} surface contracts`, () => {
      it("exposes declared surface contracts", async () => {
        const plugin = await getBundledChannelPluginAsync(id);
        if (!plugin) {
          throw new Error(`Missing bundled channel plugin for ${id}`);
        }
        const surfaces = channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface]));
        for (const surface of surfaces) {
          expectChannelSurfaceContract({
            plugin,
            surface,
          });
        }
      });
    });
  }
}

export function installDirectoryContractRegistryShard(params: ContractShardParams) {
  const entries = getDirectoryContractRegistryShardRefs(params);
  if (entries.length === 0) {
    installEmptyShardSuite("directory contract registry shard");
    return;
  }
  const pluginCache = new Map<string, Awaited<ReturnType<typeof getBundledChannelPluginAsync>>>();
  beforeAll(async () => {
    await Promise.all(
      entries.map(async (entry) => {
        pluginCache.set(entry.id, await getBundledChannelPluginAsync(entry.id));
      }),
    );
  });
  for (const entry of entries) {
    describe(`${entry.id} directory contract`, () => {
      it("exposes the base directory contract", async () => {
        const plugin = pluginCache.get(entry.id);
        if (!plugin) {
          throw new Error(`Missing bundled channel plugin for ${entry.id}`);
        }
        await expectChannelDirectoryBaseContract({
          plugin,
          coverage: entry.coverage,
        });
      });
    });
  }
}

export function installThreadingContractRegistryShard(params: ContractShardParams) {
  const entries = getThreadingContractRegistryShardRefs(params);
  if (entries.length === 0) {
    installEmptyShardSuite("threading contract registry shard");
    return;
  }
  for (const entry of entries) {
    describe(`${entry.id} threading contract`, () => {
      it("exposes the base threading contract", async () => {
        const plugin = await getBundledChannelPluginAsync(entry.id);
        if (!plugin) {
          throw new Error(`Missing bundled channel plugin for ${entry.id}`);
        }
        expectChannelThreadingBaseContract(plugin);
      });

      it("keeps threading return values normalized", async () => {
        const plugin = await getBundledChannelPluginAsync(entry.id);
        if (!plugin) {
          throw new Error(`Missing bundled channel plugin for ${entry.id}`);
        }
        expectChannelThreadingReturnValuesNormalized(plugin);
      });
    });
  }
}

export function installPluginContractRegistryShard(params: ContractShardParams) {
  const entries = getPluginContractRegistryShardRefs(params);
  if (entries.length === 0) {
    installEmptyShardSuite("plugin contract registry shard");
    return;
  }
  for (const entry of entries) {
    describe(`${entry.id} plugin contract`, () => {
      it("satisfies the base channel plugin contract", async () => {
        const plugin = await getBundledChannelPluginAsync(entry.id);
        if (!plugin) {
          throw new Error(`Missing bundled channel plugin for ${entry.id}`);
        }
        expectChannelPluginContract(plugin);
      });
    });
  }
}
