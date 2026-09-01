// Feishu plugin module test runtime stub.
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "../../runtime-api.js";

export const feishuRuntimeStub = {
  state: {
    openKeyedStore: (options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests("feishu", options),
    openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests("feishu", options),
    resolveStateDir: (env: NodeJS.ProcessEnv = process.env, homedir?: () => string) => {
      const override = env.OPENCLAW_STATE_DIR?.trim();
      if (override) {
        return override;
      }
      const resolvedHome = homedir ? homedir() : os.homedir();
      return path.join(resolvedHome, ".openclaw");
    },
  },
} as unknown as PluginRuntime;
