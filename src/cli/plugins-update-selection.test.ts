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

  it("resolves a packed child update to its tracked package owner", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          pack: createNpmInstall({ spec: "@acme/pack", resolvedName: "@acme/pack" }),
        },
        installOwnerByPluginId: new Map([
          ["pack/one", "pack"],
          ["pack/two", "pack"],
        ]),
        rawId: "pack/two",
      }),
    ).toEqual({ pluginIds: ["pack"] });
  });

  it("does not infer a packed child owner when owner metadata is missing", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          pack: createNpmInstall({ spec: "@acme/pack", resolvedName: "@acme/pack" }),
        },
        rawId: "pack/two",
      }),
    ).toEqual({ pluginIds: [] });
  });

  it("rejects an ambiguous child before exact install-record selection", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          "pack/one": createNpmInstall({ spec: "@acme/pack" }),
          "pack/two": createNpmInstall({ spec: "@acme/pack" }),
        },
        rejectedPluginIds: new Map([
          ["pack/one", "ambiguous pack/one"],
          ["pack/two", "ambiguous pack/two"],
        ]),
        rawId: "pack/one",
      }),
    ).toEqual({ pluginIds: [], error: "ambiguous pack/one" });
  });

  it("rejects an ambiguous package owner for targeted and update-all selection", () => {
    const installs = {
      pack: createNpmInstall({ spec: "@acme/pack" }),
      stable: createNpmInstall({ spec: "@acme/stable" }),
    };
    const rejectedPluginIds = new Map([["pack", "ambiguous pack"]]);

    expect(resolvePluginUpdateSelection({ installs, rejectedPluginIds, rawId: "pack" })).toEqual({
      pluginIds: [],
      error: "ambiguous pack",
    });
    expect(resolvePluginUpdateSelection({ installs, rejectedPluginIds, all: true })).toEqual({
      pluginIds: [],
      error: "ambiguous pack",
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
  it.each([
    { packageName: "@acme/demo-hooks", requestedSpec: "@acme/demo-hooks" },
    { packageName: "openclaw-demo-hooks", requestedSpec: "openclaw-demo-hooks" },
    { packageName: "@acme/demo-hooks", requestedSpec: "@acme/demo-hooks@beta" },
    { packageName: "@acme/demo-hooks", requestedSpec: "@acme/demo-hooks@1.2.3" },
  ])(
    "maps npm package spec $requestedSpec to its tracked hook pack",
    ({ packageName, requestedSpec }) => {
      expect(
        resolveHookPackUpdateSelection({
          installs: {
            "demo-hooks": createNpmHookInstall({
              spec: `${packageName}@1.0.0`,
              resolvedName: packageName,
            }),
          },
          rawId: requestedSpec,
        }),
      ).toEqual({
        hookIds: ["demo-hooks"],
        specOverrides: { "demo-hooks": requestedSpec },
      });
    },
  );

  it("preserves the tracked npm spec when updating by exact hook-pack id", () => {
    expect(
      resolveHookPackUpdateSelection({
        installs: {
          "demo-hooks": createNpmHookInstall({ spec: "@acme/demo-hooks@beta" }),
        },
        rawId: "demo-hooks",
      }),
    ).toEqual({ hookIds: ["demo-hooks"] });
  });

  it("does not guess an owner when an npm package maps to multiple tracked hook packs", () => {
    expect(
      resolveHookPackUpdateSelection({
        installs: {
          alpha: createNpmHookInstall({ spec: "@acme/shared" }),
          beta: createNpmHookInstall({ spec: "@acme/shared" }),
        },
        rawId: "@acme/shared",
      }),
    ).toEqual({ hookIds: [] });
  });

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
