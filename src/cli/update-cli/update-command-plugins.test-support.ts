import { collectMissingPluginInstallPayloads } from "../../plugins/payload-verification.js";
import { buildInvalidConfigPostCoreUpdateResult } from "./update-command-plugins-internals.js";

export const testing = {
  buildInvalidConfigPostCoreUpdateResult,
  collectMissingPluginInstallPayloads,
};
