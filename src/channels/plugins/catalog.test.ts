import { describe, expect, it } from "vitest";
import { getChannelPluginCatalogEntry } from "./catalog.js";

describe("channel plugin catalog", () => {
  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };

    expect(getChannelPluginCatalogEntry("wecom", options)).toEqual(
      expect.objectContaining({
        id: "wecom",
        pluginId: "wecom-openclaw-plugin",
        trustedSourceLinkedOfficialInstall: true,
        install: expect.objectContaining({
          npmSpec: "@wecom/wecom-openclaw-plugin@2026.4.23",
        }),
      }),
    );
    expect(getChannelPluginCatalogEntry("yuanbao", options)).toEqual(
      expect.objectContaining({
        id: "yuanbao",
        pluginId: "openclaw-plugin-yuanbao",
        trustedSourceLinkedOfficialInstall: true,
        install: expect.objectContaining({
          npmSpec: "openclaw-plugin-yuanbao@2.13.1",
        }),
      }),
    );
  });
});
