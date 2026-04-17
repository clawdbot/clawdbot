import { describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "mattermost" && artifactBasename === "gateway-auth-api.js") {
        return {
          resolveGatewayAuthBypassPaths: () => [
            " /api/channels/mattermost/command ",
            "",
            null,
            "/api/channels/mattermost/work",
          ],
        };
      }
      if (dirName === "broken" && artifactBasename === "gateway-auth-api.js") {
        throw new Error("broken gateway auth artifact");
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

import { resolveBundledChannelGatewayAuthBypassPaths } from "./gateway-auth-bypass.js";

describe("bundled channel gateway auth bypass fast path", () => {
  it("loads the narrow gateway auth artifact for configured channels", () => {
    const paths = resolveBundledChannelGatewayAuthBypassPaths({
      channelId: "mattermost",
      cfg: { channels: { mattermost: {} } },
    });

    expect(paths).toEqual(["/api/channels/mattermost/command", "/api/channels/mattermost/work"]);
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "mattermost",
      artifactBasename: "gateway-auth-api.js",
    });
  });

  it("treats missing gateway auth artifacts as no bypass paths", () => {
    expect(
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "discord",
        cfg: { channels: { discord: {} } },
      }),
    ).toEqual([]);
  });

  it("surfaces errors from present gateway auth artifacts", () => {
    expect(() =>
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "broken",
        cfg: { channels: { broken: {} } },
      }),
    ).toThrow("broken gateway auth artifact");
  });
});
