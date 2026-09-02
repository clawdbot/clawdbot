import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { PluginRuntimeGatewayCronHostService } from "../plugins/registry-runtime-gateway-cron.js";
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
  const composeCommitGuard = (commitGuard?: () => void) => () => {
    assertActive();
    commitGuard?.();
  };
  const service: PluginRuntimeGatewayCronHostService = {
    list: async (opts) => await resolveCron().list(opts),
    add: async (input, opts) => {
      const normalized = normalizeCronJobCreate(input);
      if (!normalized) {
        throw new Error("Gateway cron create input is invalid.");
      }
      return await resolveCron().add(normalized, {
        commitGuard: composeCommitGuard(opts?.commitGuard),
      });
    },
    update: async (id, patch, opts) => {
      const normalized = normalizeCronJobPatch(patch);
      if (!normalized) {
        throw new Error("Gateway cron update input is invalid.");
      }
      return await resolveCron().update(id, normalized, {
        commitGuard: composeCommitGuard(opts?.commitGuard),
      });
    },
    remove: async (id, opts) =>
      await resolveCron().remove(id, { commitGuard: composeCommitGuard(opts?.commitGuard) }),
    removeStaleJobFamily: async (family, opts) =>
      await resolveCron().removeStaleJobFamily(family, {
        commitGuard: composeCommitGuard(opts?.commitGuard),
      }),
  };
  return {
    getService: () => (resolveGatewayContext?.()?.cron ? service : undefined),
    retire: () => {
      active = false;
    },
  };
}
