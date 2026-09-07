import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginHookGatewayCronService } from "./hook-types.js";

export type PluginServiceCronHost = Pick<
  GatewayCronServiceContract,
  keyof PluginHookGatewayCronService
>;

export function createPluginServiceCronGetter(params: {
  getCron: () => PluginServiceCronHost | null | undefined;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
}): () => PluginHookGatewayCronService | undefined {
  let current: { cron: PluginServiceCronHost; service: PluginHookGatewayCronService } | undefined;
  const assertServiceActive = () => {
    params.lease.assertActive("cron scheduler");
    if (params.isStopping()) {
      throw new Error("Plugin service cron scheduler is stopping");
    }
  };
  return () => {
    assertServiceActive();
    const cron = params.getCron();
    if (!cron) {
      return undefined;
    }
    if (current?.cron === cron) {
      return current.service;
    }
    const commitGuard = () => {
      assertServiceActive();
      if (params.getCron() !== cron) {
        throw new Error("Plugin service cron scheduler was replaced");
      }
    };
    // A retained handle owns one scheduler. Recheck at the store lock, not only
    // before awaiting it, so replacement cannot admit an old queued write.
    const service: PluginHookGatewayCronService = {
      list: async (opts) => {
        commitGuard();
        const jobs = await cron.list(opts);
        commitGuard();
        return jobs;
      },
      add: async (input) => {
        commitGuard();
        const normalized = normalizeCronJobCreate(input);
        if (!normalized) {
          throw new Error("Plugin service cron create input is invalid");
        }
        return await cron.add(normalized, { commitGuard });
      },
      update: async (id, patch) => {
        commitGuard();
        const normalized = normalizeCronJobPatch(patch);
        if (!normalized) {
          throw new Error("Plugin service cron update input is invalid");
        }
        return await cron.update(id, normalized, { commitGuard });
      },
      remove: async (id) => {
        commitGuard();
        return await cron.remove(id, { commitGuard });
      },
      removeStaleJobFamily: async (family) => {
        commitGuard();
        return await cron.removeStaleJobFamily(family, { commitGuard });
      },
    };
    current = { cron, service };
    return service;
  };
}
