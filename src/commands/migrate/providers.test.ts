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
  it("returns a lightweight provider without loading its full runtime", () => {
    const config = {} as OpenClawConfig;
    const provider = {
      id: "fixture",
      label: "Fixture",
      plan: vi.fn(),
      apply: vi.fn(),
    } satisfies MigrationProviderPlugin;
    migrationRuntimeMocks.resolveProvider.mockReturnValueOnce(provider);

    expect(resolveMigrationProvider("fixture", config)).toBe(provider);
    expect(migrationRuntimeMocks.ensureLoaded).not.toHaveBeenCalled();
  });

  it("loads an unresolved provider before trying again", () => {
    const config = {} as OpenClawConfig;
    const provider = {
      id: "fixture",
      label: "Fixture",
      plan: vi.fn(),
      apply: vi.fn(),
    } satisfies MigrationProviderPlugin;
    migrationRuntimeMocks.resolveProvider.mockReturnValueOnce(undefined).mockReturnValue(provider);

    expect(resolveMigrationProvider("fixture", config)).toBe(provider);
    expect(migrationRuntimeMocks.ensureLoaded).toHaveBeenCalledWith({
      cfg: config,
      providerId: "fixture",
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
