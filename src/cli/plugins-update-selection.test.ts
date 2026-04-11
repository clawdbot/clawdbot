import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginUpdateSelection } from "./plugins-update-selection.js";

function createNpmInstall(params: {
  spec: string;
  installPath?: string;
  resolvedName?: string;
}): PluginInstallRecord {
  return {
    source: "npm",
    spec: params.spec,
    installPath: params.installPath ?? "/tmp/plugin",
    ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
  };
}

describe("resolvePluginUpdateSelection", () => {
  it("maps an explicit unscoped npm dist-tag update to the tracked plugin id", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          "openclaw-codex-app-server": createNpmInstall({
            spec: "openclaw-codex-app-server",
            installPath: "/tmp/openclaw-codex-app-server",
            resolvedName: "openclaw-codex-app-server",
          }),
        },
        rawId: "openclaw-codex-app-server@beta",
      }),
    ).toEqual({
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
      },
    });
  });

  it("maps an explicit scoped npm dist-tag update to the tracked plugin id", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          "voice-call": createNpmInstall({
            spec: "@openclaw/voice-call",
            installPath: "/tmp/voice-call",
            resolvedName: "@openclaw/voice-call",
          }),
        },
        rawId: "@openclaw/voice-call@beta",
      }),
    ).toEqual({
      pluginIds: ["voice-call"],
      specOverrides: {
        "voice-call": "@openclaw/voice-call@beta",
      },
    });
  });

  it("maps an explicit npm version update to the tracked plugin id", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          "openclaw-codex-app-server": createNpmInstall({
            spec: "openclaw-codex-app-server",
            installPath: "/tmp/openclaw-codex-app-server",
            resolvedName: "openclaw-codex-app-server",
          }),
        },
        rawId: "openclaw-codex-app-server@0.2.0-beta.4",
      }),
    ).toEqual({
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
      },
    });
  });

  it("keeps recorded npm tags when update is invoked by plugin id", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          "openclaw-codex-app-server": createNpmInstall({
            spec: "openclaw-codex-app-server@beta",
            installPath: "/tmp/openclaw-codex-app-server",
            resolvedName: "openclaw-codex-app-server",
          }),
        },
        rawId: "openclaw-codex-app-server",
      }),
    ).toEqual({
      pluginIds: ["openclaw-codex-app-server"],
    });
  });
});
