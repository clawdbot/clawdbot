// Plugin update selection tests cover CLI plugin update target selection.
import { describe, expect, it } from "vitest";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";

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

function createNpmHookInstall(params: {
  spec: string;
  installPath?: string;
  resolvedName?: string;
}): HookInstallRecord {
  return {
    source: "npm",
    spec: params.spec,
    installPath: params.installPath ?? "/tmp/hook-pack",
    ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
  };
}

describe("resolvePluginUpdateSelection", () => {
  it.each(["missing-plugin", "@acme/missing-plugin@beta", "constructor"])(
    "does not select the untracked plugin target %s",
    (rawId) => {
      expect(resolvePluginUpdateSelection({ installs: {}, rawId })).toEqual({ pluginIds: [] });
    },
  );

  it("does not guess an owner when an npm package maps to multiple tracked plugins", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          alpha: createNpmInstall({ spec: "@acme/shared", resolvedName: "@acme/shared" }),
          beta: createNpmInstall({ spec: "@acme/shared", resolvedName: "@acme/shared" }),
        },
        rawId: "@acme/shared@beta",
      }),
    ).toEqual({ pluginIds: [] });
  });

  it.each([
    {
      title: "maps an explicit unscoped npm dist-tag update to the tracked plugin id",
      pluginId: "openclaw-codex-app-server",
      packageNameWithSpec: "openclaw-codex-app-server",
      installPath: "/tmp/openclaw-codex-app-server",
      packageName: "openclaw-codex-app-server",
      requestedSpec: "openclaw-codex-app-server@beta",
      expectedPluginId: "openclaw-codex-app-server",
      expectedTrackedId: "openclaw-codex-app-server",
      expectedSpec: "openclaw-codex-app-server@beta",
    },
    {
      title: "maps an explicit scoped npm dist-tag update to the tracked plugin id",
      pluginId: "voice-call",
      packageNameWithSpec: "@openclaw/voice-call",
      installPath: "/tmp/voice-call",
      packageName: "@openclaw/voice-call",
      requestedSpec: "@openclaw/voice-call@beta",
      expectedPluginId: "voice-call",
      expectedTrackedId: "voice-call",
      expectedSpec: "@openclaw/voice-call@beta",
    },
    {
      title: "maps an explicit npm version update to the tracked plugin id",
      pluginId: "openclaw-codex-app-server",
      packageNameWithSpec: "openclaw-codex-app-server",
      installPath: "/tmp/openclaw-codex-app-server",
      packageName: "openclaw-codex-app-server",
      requestedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
      expectedPluginId: "openclaw-codex-app-server",
      expectedTrackedId: "openclaw-codex-app-server",
      expectedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
    },
    {
      title: "maps a bare scoped npm package update to the tracked plugin id",
      pluginId: "lossless-claw",
      packageNameWithSpec: "@martian-engineering/lossless-claw@0.9.0",
      installPath: "/tmp/lossless-claw",
      packageName: "@martian-engineering/lossless-claw",
      requestedSpec: "@martian-engineering/lossless-claw",
      expectedPluginId: "lossless-claw",
      expectedTrackedId: "lossless-claw",
      expectedSpec: "@martian-engineering/lossless-claw",
    },
  ])(
    "$title",
    ({
      pluginId,
      packageNameWithSpec,
      installPath,
      packageName,
      requestedSpec,
      expectedPluginId,
      expectedTrackedId,
      expectedSpec,
    }) => {
      expect(
        resolvePluginUpdateSelection({
          installs: {
            [pluginId]: createNpmInstall({
              spec: packageNameWithSpec,
              installPath,
              resolvedName: packageName,
            }),
          },
          rawId: requestedSpec,
        }),
      ).toEqual({
        pluginIds: [expectedPluginId],
        specOverrides: {
          [expectedTrackedId]: expectedSpec,
        },
      });
    },
  );

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

  it("maps prototype-named npm packages by own install records", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          "tracked-constructor": createNpmInstall({
            spec: "constructor",
            resolvedName: "constructor",
          }),
        },
        rawId: "constructor",
      }),
    ).toEqual({
      pluginIds: ["tracked-constructor"],
      specOverrides: {
        "tracked-constructor": "constructor",
      },
    });
  });
});

describe("resolveHookPackUpdateSelection", () => {
  it("does not treat inherited prototype keys as installed hook ids", () => {
    expect(
      resolveHookPackUpdateSelection({
        installs: {},
        rawId: "constructor",
      }),
    ).toEqual({
      hookIds: [],
    });
  });

  it("keeps own prototype-named hook ids selectable", () => {
    expect(
      resolveHookPackUpdateSelection({
        installs: {
          constructor: createNpmHookInstall({
            spec: "openclaw-hooks-constructor",
            resolvedName: "openclaw-hooks-constructor",
          }),
        },
        rawId: "constructor",
      }),
    ).toEqual({
      hookIds: ["constructor"],
    });
  });
});
