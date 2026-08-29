// Retained core-version repairs apply only before an installed plugin owns the channel.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = getRegistryJitiMocks();
const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
let doctor: typeof import("./doctor-contract-registry.js");
function makeTempDir() {
  return tempDirs.make("openclaw-retained-config-doctor-");
}

beforeAll(async () => {
  vi.resetModules();
  doctor = await import("./doctor-contract-registry.js");
});
beforeEach(() => {
  resetRegistryJitiMocks();
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  retainedConfigDoctorMock.mockReset().mockReturnValue(null);
});

describe("retained channel config repairs", () => {
  it("repairs retained channel config before installation without selecting state owners", () => {
    const rule = { path: ["channels", "discord", "dm", "policy"], message: "retired DM policy" };
    const config = {
      channels: { discord: { dm: { enabled: true, policy: "allowlist" } } },
      plugins: { allow: [] },
    };
    retainedConfigDoctorMock.mockReturnValue({
      legacyConfigRules: [rule],
      normalizeCompatibilityConfig: ({ cfg }: { cfg: typeof config }) => ({
        config: { ...cfg, channels: { discord: { dmPolicy: cfg.channels.discord.dm.policy } } },
        changes: ["moved DM policy"],
      }),
      resolveSessionStoreAgentIds: () => {
        throw new Error("must not select retained state owners");
      },
    });

    expect(doctor.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([rule]);
    expect(doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} })).toEqual({
      config: { channels: { discord: { dmPolicy: "allowlist" } }, plugins: { allow: [] } },
      changes: ["moved DM policy"],
    });
    expect(config.channels.discord.dm.policy).toBe("allowlist");
    expect(retainedConfigDoctorMock).toHaveBeenCalledWith({
      dirName: "discord",
      artifactCandidates: ["config-doctor-api.js"],
      env: {},
    });
    retainedConfigDoctorMock.mockClear();
    expect(doctor.listPluginDoctorSessionStoreAgentIds({ config, env: {} })).toEqual([]);
    expect(doctor.listPluginDoctorSessionRouteStateOwners({ config, env: {} })).toEqual([]);
    expect(retainedConfigDoctorMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "never replaces an installed channel owner (configRepair=%s)",
    (configRepair) => {
      const pluginRoot = makeTempDir();
      mocks.loadPluginManifestRegistry.mockReturnValue({
        plugins: [
          {
            id: "installed-owner",
            channels: ["discord"],
            providers: [],
            rootDir: pluginRoot,
            doctorContract: { configRepair },
          },
        ],
        diagnostics: [],
      });
      const config = { channels: { discord: { dm: { enabled: true, policy: "allowlist" } } } };
      expect(doctor.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([]);
      expect(doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} })).toEqual({
        config,
        changes: [],
      });
      expect(retainedConfigDoctorMock).not.toHaveBeenCalled();
    },
  );

  it("does not probe retained modules outside the selected known channel scope", () => {
    const config = { channels: { discord: {}, "../outside": {}, defaults: {} } };
    expect(
      doctor.listPluginDoctorLegacyConfigRules({ config, env: {}, pluginIds: ["slack"] }),
    ).toEqual([]);
    expect(
      doctor.listPluginDoctorLegacyConfigRules({
        config: { channels: { "../outside": {} } },
        env: {},
      }),
    ).toEqual([]);
    expect(retainedConfigDoctorMock).not.toHaveBeenCalled();
  });
});
