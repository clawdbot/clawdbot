import { describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "discord" && artifactBasename === "doctor-contract-api.js") {
        return {
          legacyConfigRules: [
            {
              path: ["channels", "discord", "voice", "tts"],
              message: "legacy discord rule",
            },
          ],
        };
      }
      if (dirName === "telegram" && artifactBasename === "contract-api.js") {
        return {
          legacyConfigRules: [
            {
              path: ["channels", "telegram", "groupMentionsOnly"],
              message: "legacy telegram rule",
            },
          ],
        };
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";

describe("channel doctor contract api fast path", () => {
  it("prefers the explicit doctor contract artifact for bundled channels", () => {
    const api = loadBundledChannelDoctorContractApi("discord");

    expect(api?.legacyConfigRules).toEqual([
      {
        path: ["channels", "discord", "voice", "tts"],
        message: "legacy discord rule",
      },
    ]);
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "discord",
      artifactBasename: "doctor-contract-api.js",
    });
  });

  it("falls back to the generic contract artifact when the doctor artifact is absent", () => {
    const api = loadBundledChannelDoctorContractApi("telegram");

    expect(api?.legacyConfigRules).toEqual([
      {
        path: ["channels", "telegram", "groupMentionsOnly"],
        message: "legacy telegram rule",
      },
    ]);
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "telegram",
      artifactBasename: "doctor-contract-api.js",
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "telegram",
      artifactBasename: "contract-api.js",
    });
  });
});
