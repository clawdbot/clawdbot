import type { PluginLogger } from "../plugins/types.js";

export const quietPluginJsonLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
