import { fileURLToPath } from "node:url";
import { definePluginEntry, type OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./src/crabbox-worker-provider.js";

const workerWallpaperPath = fileURLToPath(
  new URL("./assets/openclaw-worker-wallpaper.png", import.meta.url),
);

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Worker Provider",
  description: "Cloud worker provider backed by the Crabbox CLI",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerCrabboxWarmImageCommands } =
          await import("./src/crabbox-worker-warm-image-cli.js");
        registerCrabboxWarmImageCommands(program);
      },
      {
        descriptors: [
          {
            name: "crabbox",
            description: "Inspect and recover Crabbox warm images",
            hasSubcommands: true,
          },
        ],
      },
    );
    const provider = createCrabboxWorkerProvider({
      openclawRoot: resolveOpenClawRoot(api.rootDir),
      wallpaperPath: workerWallpaperPath,
      warn: (message) => api.logger.warn(message),
    });
    api.registerWorkerProvider(provider);
    // Worker sidecars stop first; plugin services own generation-wide heartbeat cleanup.
    api.registerService({
      id: "crabbox-worker-cleanup",
      start() {},
      stop() {
        return provider.dispose();
      },
    } satisfies OpenClawPluginService);
  },
});
