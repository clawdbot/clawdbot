import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  PROVIDER_ENV_VARS,
} from "./provider-env-vars.js";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    kind?: "memory" | "context-engine" | Array<"memory" | "context-engine">;
    providerAuthEnvVars?: Record<string, string[]>;
    providerAuthAliases?: Record<string, string>;
  }>;
  diagnostics: unknown[];
};

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({ plugins: [], diagnostics: [] })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

describe("provider env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
    __testing.resetProviderEnvVarCachesForTests();
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
          providerAuthAliases: {
            "fireworks-plan": "fireworks",
          },
        },
      ],
      diagnostics: [],
    });

    expect(getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(getProviderEnvVars("fireworks-plan")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(listKnownProviderAuthEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
    expect(listKnownSecretEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
  });

  it("keeps lazy manifest-backed exports cold until accessed and resolves them once", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(PROVIDER_ENV_VARS.fireworks).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(PROVIDER_AUTH_ENV_VAR_CANDIDATES.fireworks).toEqual(["FIREWORKS_ALT_API_KEY"]);
    const initialLoads = loadPluginManifestRegistry.mock.calls.length;
    expect(initialLoads).toBeGreaterThan(0);

    void PROVIDER_ENV_VARS.fireworks;
    void PROVIDER_AUTH_ENV_VAR_CANDIDATES.fireworks;
    expect(loadPluginManifestRegistry).toHaveBeenCalledTimes(initialLoads);
  });

  it("keeps workspace plugin env vars in default lookups", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["WHISPERX_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.getProviderEnvVars("whisperx")).toEqual(["WHISPERX_API_KEY"]);
    expect(mod.listKnownProviderAuthEnvVarNames()).toContain("WHISPERX_API_KEY");
  });

  it("excludes untrusted workspace plugin env vars when requested", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["AWS_SECRET_ACCESS_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([]);
    expect(
      mod.listKnownProviderAuthEnvVarNames({
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("keeps explicitly trusted workspace plugin env vars when requested", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["WHISPERX_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: {
          plugins: {
            allow: ["workspace-audio"],
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual(["WHISPERX_API_KEY"]);
  });

  it("does not trust arbitrary workspace plugin ids from the context engine slot", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["AWS_SECRET_ACCESS_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: {
          plugins: {
            slots: {
              contextEngine: "workspace-audio",
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([]);
  });

  it("keeps selected workspace context engine env vars when requested", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-engine",
          origin: "workspace",
          kind: "context-engine",
          providerAuthEnvVars: {
            whisperx: ["WHISPERX_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: {
          plugins: {
            slots: {
              contextEngine: "workspace-engine",
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual(["WHISPERX_API_KEY"]);
  });
});
