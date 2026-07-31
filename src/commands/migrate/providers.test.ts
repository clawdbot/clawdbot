// Migration provider tests cover provider-specific option shaping.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationProviderPlugin } from "../../plugins/types.js";

const migrationRuntimeMocks = vi.hoisted(() => ({
  ensureLoaded: vi.fn(),
  resolveProvider: vi.fn(),
  resolveProviders: vi.fn(() => []),
}));

vi.mock("../../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded: migrationRuntimeMocks.ensureLoaded,
  resolvePluginMigrationProvider: migrationRuntimeMocks.resolveProvider,
  resolvePluginMigrationProviders: migrationRuntimeMocks.resolveProviders,
}));

import { buildMigrationProviderOptions, resolveMigrationProvider } from "./providers.js";

describe("resolveMigrationProvider", () => {
  it("loads the requested bundled provider before resolving it", () => {
    const config = {} as OpenClawConfig;
    const provider = {
      id: "hermes",
      label: "Hermes",
      plan: vi.fn(),
      apply: vi.fn(),
    } satisfies MigrationProviderPlugin;
    migrationRuntimeMocks.resolveProvider.mockReturnValueOnce(provider);

    expect(resolveMigrationProvider("hermes", config)).toBe(provider);
    expect(migrationRuntimeMocks.ensureLoaded).toHaveBeenCalledWith({
      cfg: config,
      providerId: "hermes",
    });
  });
});

describe("buildMigrationProviderOptions", () => {
  it("uses the resolved provider id for Codex options", () => {
    expect(
      buildMigrationProviderOptions(
        {
          configPatchMode: "return",
          verifyPluginApps: true,
        },
        "codex",
      ),
    ).toEqual({
      configPatchMode: "return",
      verifyPluginApps: true,
    });
  });

  it("omits Codex-only options for other providers", () => {
    expect(
      buildMigrationProviderOptions(
        {
          configPatchMode: "return",
          provider: "other",
          verifyPluginApps: true,
        },
        "other",
      ),
    ).toBeUndefined();
  });
});
