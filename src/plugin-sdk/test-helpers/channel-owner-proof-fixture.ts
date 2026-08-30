import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";

/**
 * Builds the same lifecycle-bound channel runtime that a loaded plugin receives.
 * This helper is exported only from the test-fixtures SDK entrypoint.
 */
export function createChannelOwnerProofFixture<ResolvedAccount, Probe, Audit>(params: {
  plugin: ChannelPlugin<ResolvedAccount, Probe, Audit>;
  origin: PluginOrigin;
  config: OpenClawConfig;
}): {
  runtime: PluginRuntime;
  hostRuntime: PluginRuntime;
  channelRuntime: PluginRuntime["channel"];
  retire: () => void;
} {
  const hostRuntime = createPluginRuntime();
  const configRuntime: PluginRuntime["config"] = {
    ...hostRuntime.config,
    current: () => params.config,
  };
  const fixtureHostRuntime = {
    ...hostRuntime,
    config: configRuntime,
  } as PluginRuntime;
  const registryBuilder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: fixtureHostRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: params.plugin.id, origin: params.origin });
  const api = registryBuilder.createApi(record, {
    config: params.config,
    registrationMode: "full",
  });
  api.registerChannel({ plugin: params.plugin as unknown as ChannelPlugin });
  registryBuilder.registry.plugins.push(record);
  markPluginRegistryActive(registryBuilder.registry);

  const registration = registryBuilder.registry.channels.find(
    (candidate) => candidate.plugin.id === params.plugin.id,
  );
  const registeredChannelRuntime = registration?.resolveChannelRuntime?.();
  if (!registeredChannelRuntime) {
    throw new Error(`missing registered channel runtime for ${params.plugin.id}`);
  }

  return {
    runtime: {
      ...fixtureHostRuntime,
      channel: registeredChannelRuntime,
    } as PluginRuntime,
    hostRuntime: fixtureHostRuntime,
    channelRuntime: registeredChannelRuntime,
    retire: () => markPluginRegistryRetired(registryBuilder.registry),
  };
}
