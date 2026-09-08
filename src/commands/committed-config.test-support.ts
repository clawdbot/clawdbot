import { vi } from "vitest";
import { createTestConfigFileStore } from "./test-runtime-config-helpers.js";

export const committedConfigFiles = createTestConfigFileStore();

vi.mock("../config/io.factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.factory.js")>();
  return {
    ...actual,
    createConfigIO: (options: Parameters<typeof actual.createConfigIO>[0]) => {
      const io = actual.createConfigIO(options);
      const configPath = options?.configPath;
      return configPath
        ? {
            ...io,
            readConfigFileSnapshotWithPluginMetadata: async () =>
              committedConfigFiles.read(configPath),
          }
        : io;
    },
  };
});
