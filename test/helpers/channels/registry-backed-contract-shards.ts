import { describe, it } from "vitest";
import { installChannelPluginContractSuite } from "./registry-contract-suites.js";
import { getPluginContractRegistryShard } from "./registry-plugin.js";
import {
  getDirectoryContractRegistryShard,
  getSurfaceContractRegistryShard,
  getThreadingContractRegistryShard,
} from "./surface-contract-registry.js";
import { installChannelSurfaceContractSuite } from "./surface-contract-suite.js";
import {
  installChannelDirectoryContractSuite,
  installChannelThreadingContractSuite,
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
  const entries = getSurfaceContractRegistryShard(params);
  if (entries.length === 0) {
    installEmptyShardSuite("surface contract registry shard");
    return;
  }
  for (const entry of entries) {
    for (const surface of entry.surfaces) {
      describe(`${entry.id} ${surface} surface contract`, () => {
        installChannelSurfaceContractSuite({
          plugin: entry.plugin,
          surface,
        });
      });
    }
  }
}

export function installDirectoryContractRegistryShard(params: ContractShardParams) {
  const entries = getDirectoryContractRegistryShard(params);
  if (entries.length === 0) {
    installEmptyShardSuite("directory contract registry shard");
    return;
  }
  for (const entry of entries) {
    describe(`${entry.id} directory contract`, () => {
      installChannelDirectoryContractSuite({
        plugin: entry.plugin,
        coverage: entry.coverage,
        cfg: entry.cfg,
        accountId: entry.accountId,
      });
    });
  }
}

export function installThreadingContractRegistryShard(params: ContractShardParams) {
  const entries = getThreadingContractRegistryShard(params);
  if (entries.length === 0) {
    installEmptyShardSuite("threading contract registry shard");
    return;
  }
  for (const entry of entries) {
    describe(`${entry.id} threading contract`, () => {
      installChannelThreadingContractSuite({
        plugin: entry.plugin,
      });
    });
  }
}

export function installPluginContractRegistryShard(params: ContractShardParams) {
  const entries = getPluginContractRegistryShard(params);
  if (entries.length === 0) {
    installEmptyShardSuite("plugin contract registry shard");
    return;
  }
  for (const entry of entries) {
    describe(`${entry.id} plugin contract`, () => {
      installChannelPluginContractSuite({
        plugin: entry.plugin,
      });
    });
  }
}
