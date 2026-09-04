// Runtime web-channel plugin helpers expose web-channel tools through activated plugin runtimes.
import path from "node:path";
import type { PluginOrigin } from "../plugin-origin.types.js";
import {
  loadPluginBoundaryModule,
  resolvePluginRuntimeRecordByEntryBaseNames,
  resolvePluginRuntimeModulePath,
} from "./runtime-plugin-boundary.js";

type WebChannelPluginRecord = {
  origin?: PluginOrigin;
  rootDir?: string;
  source: string;
};

type WebChannelHeavyRuntimeModule = {
  monitorWebChannel: (...args: unknown[]) => Promise<unknown>;
};

/** Resolves the active web-channel plugin record that provides runtime APIs. */
function resolveWebChannelPluginRecord(): WebChannelPluginRecord {
  return resolvePluginRuntimeRecordByEntryBaseNames(["light-runtime-api", "runtime-api"], () => {
    throw new Error(
      "web channel plugin runtime is unavailable: missing plugin that provides light-runtime-api and runtime-api",
    );
  }) as WebChannelPluginRecord;
}

function resolveWebChannelRuntimeModulePath(
  record: WebChannelPluginRecord,
  entryBaseName: "light-runtime-api" | "runtime-api",
): string {
  const modulePath = resolvePluginRuntimeModulePath(record, entryBaseName, () => {
    throw new Error(`web channel plugin runtime is unavailable: missing ${entryBaseName}`);
  });
  if (!modulePath) {
    throw new Error(`web channel plugin runtime is unavailable: missing ${entryBaseName}`);
  }
  return modulePath;
}

function loadWebChannelHeavyModuleSync(): WebChannelHeavyRuntimeModule {
  const record = resolveWebChannelPluginRecord();
  const modulePath = resolveWebChannelRuntimeModulePath(record, "runtime-api");
  return loadPluginBoundaryModule<WebChannelHeavyRuntimeModule>(modulePath, {
    origin: record.origin,
    rootDir: record.rootDir ?? path.dirname(record.source),
  });
}

async function loadWebChannelHeavyModule(): Promise<WebChannelHeavyRuntimeModule> {
  return loadWebChannelHeavyModuleSync();
}

/** Starts web-channel monitoring through the heavy runtime API. */
export function monitorWebChannel(
  ...args: Parameters<WebChannelHeavyRuntimeModule["monitorWebChannel"]>
): ReturnType<WebChannelHeavyRuntimeModule["monitorWebChannel"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.monitorWebChannel(...args));
}
