// Gateway auth bypass tests cover channel plugin paths allowed to skip gateway auth.
import { describe, expect, it, vi } from "vitest";

const { tryLoadActivatedBundledPluginPublicSurfaceModuleMock } = vi.hoisted(() => ({
  tryLoadActivatedBundledPluginPublicSurfaceModuleMock: vi.fn(
    async ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
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
      if (dirName === "disabledchannel") {
        // Activation-gated loads return null for disabled/denied plugins.
        return null;
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

vi.mock("../../plugin-sdk/facade-runtime.js", () => ({
  tryLoadActivatedBundledPluginPublicSurfaceModule:
    tryLoadActivatedBundledPluginPublicSurfaceModuleMock,
}));

import { resolveBundledChannelGatewayAuthBypassPaths } from "./gateway-auth-bypass.js";

describe("channel gateway auth bypass fast path", () => {
  it("loads the narrow gateway auth artifact for configured channels", async () => {
    const paths = await resolveBundledChannelGatewayAuthBypassPaths({
      channelId: "mattermost",
      cfg: { channels: { mattermost: {} } },
    });

    expect(paths).toEqual(["/api/channels/mattermost/command", "/api/channels/mattermost/work"]);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleMock).toHaveBeenCalledWith({
      dirName: "mattermost",
      artifactBasename: "gateway-auth-api.js",
    });
  });

  it("treats missing gateway auth artifacts as no bypass paths", async () => {
    await expect(
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "discord",
        cfg: { channels: { discord: {} } },
      }),
    ).resolves.toStrictEqual([]);
  });

  it("returns no bypass paths when plugin activation blocks the artifact", async () => {
    await expect(
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "disabledchannel",
        cfg: { channels: { disabledchannel: {} } },
      }),
    ).resolves.toStrictEqual([]);
  });

  it("surfaces errors from present gateway auth artifacts", async () => {
    await expect(
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "broken",
        cfg: { channels: { broken: {} } },
      }),
    ).rejects.toThrow("broken gateway auth artifact");
  });
});
