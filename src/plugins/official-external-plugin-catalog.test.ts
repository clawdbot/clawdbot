import { describe, expect, it } from "vitest";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

describe("official external plugin catalog", () => {
  it("resolves third-party channel lookup aliases to published plugin ids", () => {
    const wecomByChannel = getOfficialExternalPluginCatalogEntry("wecom");
    const wecomByPlugin = getOfficialExternalPluginCatalogEntry("wecom-openclaw-plugin");
    const yuanbaoByChannel = getOfficialExternalPluginCatalogEntry("yuanbao");

    expect(resolveOfficialExternalPluginId(wecomByChannel!)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginId(wecomByPlugin!)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginInstall(wecomByChannel!)?.npmSpec).toBe(
      "@wecom/wecom-openclaw-plugin@2026.4.23",
    );
    expect(resolveOfficialExternalPluginId(yuanbaoByChannel!)).toBe("openclaw-plugin-yuanbao");
    expect(resolveOfficialExternalPluginInstall(yuanbaoByChannel!)?.npmSpec).toBe(
      "openclaw-plugin-yuanbao@2.11.0",
    );
  });
});
