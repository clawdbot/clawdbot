import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export function createGatewayPluginCronRuntime(
  resolveGatewayContext: GatewayContextResolver | undefined,
): {
  getService: () => PluginHookGatewayCronService | undefined;
  retire: () => void;
} {
  let active = true;
  const assertActive = (): void => {
    if (!active) {
      throw new Error("Gateway cron is unavailable because this plugin runtime has retired.");
    }
  };
  const resolveCron = (): GatewayCronServiceContract => {
    assertActive();
    const cron = resolveGatewayContext?.()?.cron;
    if (!cron) {
      throw new Error("Gateway cron is unavailable for this plugin runtime.");
    }
    // SAFETY: Gateway owns the concrete scheduler behind this narrow plugin facade.
    return cron as GatewayCronServiceContract;
  };
  const service: PluginHookGatewayCronService = {
    list: async (opts) => await resolveCron().list(opts),
    add: async (input) => {
      const normalized = normalizeCronJobCreate(input);
      if (!normalized) {
        throw new Error("Gateway cron create input is invalid.");
      }
      return await resolveCron().add(normalized, { commitGuard: assertActive });
    },
    update: async (id, patch) => {
      const normalized = normalizeCronJobPatch(patch);
      if (!normalized) {
        throw new Error("Gateway cron update input is invalid.");
      }
      return await resolveCron().update(id, normalized, { commitGuard: assertActive });
    },
    remove: async (id) => await resolveCron().remove(id, { commitGuard: assertActive }),
    removeStaleJobFamily: async (family) =>
      await resolveCron().removeStaleJobFamily(family, { commitGuard: assertActive }),
  };
  return {
    getService: () => (resolveGatewayContext?.()?.cron ? service : undefined),
    retire: () => {
      active = false;
    },
  };
}
