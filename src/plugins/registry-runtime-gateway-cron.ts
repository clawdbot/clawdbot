import type { PluginHookGatewayCronService } from "./hook-types.js";

type CronCommitGuardOptions = {
  commitGuard?: () => void;
};

export type PluginRuntimeGatewayCronHostService = Omit<
  PluginHookGatewayCronService,
  "add" | "update" | "remove" | "removeStaleJobFamily"
> & {
  add: (
    input: Parameters<PluginHookGatewayCronService["add"]>[0],
    opts?: CronCommitGuardOptions,
  ) => ReturnType<PluginHookGatewayCronService["add"]>;
  update: (
    id: Parameters<PluginHookGatewayCronService["update"]>[0],
    patch: Parameters<PluginHookGatewayCronService["update"]>[1],
    opts?: CronCommitGuardOptions,
  ) => ReturnType<PluginHookGatewayCronService["update"]>;
  remove: (
    id: Parameters<PluginHookGatewayCronService["remove"]>[0],
    opts?: CronCommitGuardOptions,
  ) => ReturnType<PluginHookGatewayCronService["remove"]>;
  removeStaleJobFamily: (
    family: Parameters<PluginHookGatewayCronService["removeStaleJobFamily"]>[0],
    opts?: CronCommitGuardOptions,
  ) => ReturnType<PluginHookGatewayCronService["removeStaleJobFamily"]>;
};

export function createLifecycleBoundPluginCronService(params: {
  assertActive: () => void;
  resolveService: () => PluginRuntimeGatewayCronHostService | undefined;
}): PluginHookGatewayCronService {
  const resolveService = (): PluginRuntimeGatewayCronHostService => {
    params.assertActive();
    const service = params.resolveService();
    if (!service) {
      throw new Error("Gateway cron is unavailable for this plugin runtime.");
    }
    return service;
  };
  return {
    list: async (opts) => await resolveService().list(opts),
    add: async (input) => await resolveService().add(input, { commitGuard: params.assertActive }),
    update: async (id, patch) =>
      await resolveService().update(id, patch, { commitGuard: params.assertActive }),
    remove: async (id) => await resolveService().remove(id, { commitGuard: params.assertActive }),
    removeStaleJobFamily: async (family) =>
      await resolveService().removeStaleJobFamily(family, { commitGuard: params.assertActive }),
  };
}
