import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import {
  resolveOwnedManagedUpdateEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

export type OwnedManagedUpdateContext = {
  env: NodeJS.ProcessEnv;
  configSnapshot: ConfigFileSnapshot;
  pluginInstallRecords: Record<string, PluginInstallRecord>;
};

/** Inspection uses the same service selectors as finalization, without activating config/plugins. */
export async function captureOwnedManagedUpdatePreflightContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv: NodeJS.ProcessEnv;
  invocationCwd?: string;
}) {
  const state = params.stopState;
  if (state?.serviceUpdateVerdict?.kind !== "owned" || !state.serviceEnv) {
    return undefined;
  }
  return captureTargetDatabaseSchemaContext(
    stripGatewayServiceMarkerEnv(
      resolveOwnedManagedUpdateEnv({
        processEnv: params.processEnv,
        serviceEnv: state.serviceEnv,
        serviceDefinitionEnv: state.serviceDefinitionEnv,
        invocationCwd: params.invocationCwd,
      }),
    ),
  );
}

export async function revalidateUpdateDatabaseContext(
  expected: Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>>,
) {
  const current = await captureTargetDatabaseSchemaContext(expected.readEnv);
  const before = expected.configSnapshot;
  const after = current.configSnapshot;
  if (
    before.path !== after.path ||
    before.exists !== after.exists ||
    before.raw !== after.raw ||
    before.hash !== after.hash ||
    !isDeepStrictEqual(before.includedPaths ?? [], after.includedPaths ?? []) ||
    !isDeepStrictEqual(before.includeProvenance ?? [], after.includeProvenance ?? []) ||
    !isDeepStrictEqual(before.sourceConfig, after.sourceConfig)
  ) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      `Update refused: configuration changed during database admission at ${before.path}. Retry against the current configuration.`,
    );
  }
  return current;
}

/** Run one update phase under the managed Gateway's authoritative environment. */
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
  // A caller may pass process.env itself; clearing it must not erase the supplied scope.
  Object.assign(process.env, env === process.env ? previousEnv : env);
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
    stopState?.inspected !== true ||
    stopState.serviceUpdateVerdict?.kind !== "owned" ||
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
