import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRootHelpRenderOptionsForConfigSensitivePlugins } from "./root-help-live-config.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

describe("root help live config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses precomputed help when plugin-sensitive config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
      runtimeConfig: {},
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins({})).resolves.toBeNull();
  });

  it("uses snapshot runtime config when plugin config affects help", async () => {
    const runtimeConfig = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
      },
    };
    const env = {};
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins(env)).resolves.toEqual({
      config: runtimeConfig,
      env,
    });
  });
});
