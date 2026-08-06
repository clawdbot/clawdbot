import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./src/crabbox-worker-provider.js";

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Worker Provider",
  description: "Cloud worker provider backed by the Crabbox CLI",
  register(api) {
    api.registerWorkerProvider(
      createCrabboxWorkerProvider({ openclawRoot: resolveOpenClawRoot(api.rootDir) }),
    );
  },
});
