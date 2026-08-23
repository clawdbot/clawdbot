import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./src/crabbox-worker-provider.js";

const workerWallpaperPath = fileURLToPath(
  new URL("./assets/openclaw-worker-wallpaper.png", import.meta.url),
);

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Worker Provider",
  description: "Cloud worker provider backed by the Crabbox CLI",
  register(api) {
    api.registerWorkerProvider(
      createCrabboxWorkerProvider({
        openclawRoot: resolveOpenClawRoot(api.rootDir),
        wallpaperPath: workerWallpaperPath,
        warn: (message) => api.logger.warn(message),
      }),
    );
  },
});
