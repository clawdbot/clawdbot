import {
  buildChannelConfigSchema,
  DmPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { z } from "openclaw/plugin-sdk/zod";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "package-consumer",
  errorMessage: "package consumer runtime not initialized",
});

export const configSchema = buildChannelConfigSchema(
  z.object({
    dmPolicy: DmPolicySchema.optional(),
  }),
);

declare const plugin: Parameters<typeof defineChannelPluginEntry>[0]["plugin"];

export default defineChannelPluginEntry({
  id: "package-consumer",
  name: "Package Consumer",
  description: "Published Plugin SDK declaration compatibility fixture",
  plugin,
  setRuntime: runtimeStore.setRuntime,
});
