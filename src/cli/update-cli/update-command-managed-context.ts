import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { resolveOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  stripGatewayServiceMarkerEnv,
  type PreManagedServiceStop,
} from "./update-command-service.js";

export type OwnedManagedUpdateContext = {
  env: NodeJS.ProcessEnv;
  configSnapshot: ConfigFileSnapshot;
  pluginInstallRecords: Record<string, PluginInstallRecord>;
};

/** Run one update phase under the stopped managed Gateway's authoritative environment. */
export async function withOwnedManagedUpdateEnv<T>(
  env: NodeJS.ProcessEnv | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!env) {
    return await run();
  }
  // Update finalization is a single serialized CLI phase. Some plugin/config owners still read
  // process.env, so switch the complete phase atomically and restore the caller afterward.
  const previousEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

export async function captureOwnedManagedUpdateContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): Promise<OwnedManagedUpdateContext | undefined> {
  const stopState = params.stopState;
  if (
    stopState?.stopped !== true ||
    stopState.serviceMatchesMutationRoot !== true ||
    !stopState.serviceEnv
  ) {
    return undefined;
  }
  const env = stripGatewayServiceMarkerEnv(
    resolveOwnedManagedUpdateEnv({
      processEnv: params.processEnv,
      serviceEnv: stopState.serviceEnv,
      serviceDefinitionEnv: stopState.serviceDefinitionEnv,
      invocationCwd: params.invocationCwd,
    }),
  );
  // Every later schema, doctor, recovery, and restart step consumes serviceEnv. Promote the
  // normalized owned environment before I/O so even capture failure recovery targets its owner.
  stopState.serviceEnv = env;
  return await withOwnedManagedUpdateEnv(env, async () => {
    const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords({ env });
    return { env, configSnapshot, pluginInstallRecords };
  });
}
