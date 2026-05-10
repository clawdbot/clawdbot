import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV,
  PLUGIN_INSTALL_OVERRIDES_ENV,
  resolvePluginInstallOverride,
} from "./install-overrides.js";

describe("plugin install overrides", () => {
  it("requires an explicit allow flag", () => {
    expect(
      resolvePluginInstallOverride({
        pluginId: "codex",
        env: {
          [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({ codex: "npm:@openclaw/codex@1.0.0" }),
        },
      }),
    ).toBeNull();
  });

  it("resolves the matching npm override from a multi-plugin map", () => {
    expect(
      resolvePluginInstallOverride({
        pluginId: "codex",
        env: {
          [ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]: "1",
          [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({
            codex: "npm:@openclaw/codex@2026.5.8",
            "demo-plugin": "npm-pack:./demo.tgz",
          }),
        },
      }),
    ).toEqual({ kind: "npm", spec: "@openclaw/codex@2026.5.8" });
  });

  it("resolves npm-pack paths to absolute archive paths", () => {
    expect(
      resolvePluginInstallOverride({
        pluginId: "demo-plugin",
        env: {
          [ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]: "1",
          [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({
            "demo-plugin": "npm-pack:./demo.tgz",
          }),
        },
      }),
    ).toEqual({ kind: "npm-pack", archivePath: path.resolve("demo.tgz") });
  });

  it("rejects malformed specs", () => {
    expect(
      resolvePluginInstallOverride({
        pluginId: "codex",
        env: {
          [ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]: "1",
          [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({ codex: "file:./codex" }),
        },
      }),
    ).toBeNull();
  });
});
