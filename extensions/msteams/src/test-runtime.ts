import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "../runtime-api.js";

export const msteamsRuntimeStub = {
  state: {
    resolveStateDir: (env: NodeJS.ProcessEnv = process.env, homedir?: () => string) => {
      const override = env.OPENCLAW_STATE_DIR?.trim() || env.OPENCLAW_STATE_DIR?.trim();
      if (override) {
        return override;
      }
      const resolvedHome = homedir ? homedir() : os.homedir();
      return path.join(resolvedHome, ".openclaw");
    },
  },
} as unknown as PluginRuntime;
