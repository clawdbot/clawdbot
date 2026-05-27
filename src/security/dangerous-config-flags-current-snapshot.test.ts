import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginConfigContractsById } from "../plugins/config-contracts.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../plugins/config-contracts.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/config-contracts.js")>(
    "../plugins/config-contracts.js",
  );
  return {
    ...actual,
    resolvePluginConfigContractsById: vi.fn(() => {
      throw new Error("unexpected manifest resolver call");
    }),
  };
});

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEnabledInsecureOrDangerousFlags current metadata snapshot", () => {
  afterEach(() => {
    vi.mocked(getCurrentPluginMetadataSnapshot).mockReset();
    vi.mocked(resolvePluginConfigContractsById).mockClear();
  });

  it("uses current plugin metadata contracts when the caller prefers the gateway snapshot", () => {
    vi.mocked(getCurrentPluginMetadataSnapshot).mockReturnValue({
      normalizePluginId: (pluginId: string) => pluginId,
      byPluginId: new Map([
        [
          "acpx",
          {
            id: "acpx",
            origin: "bundled",
            configContracts: {
              dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
            },
          },
        ],
      ]),
    } as unknown as ReturnType<typeof getCurrentPluginMetadataSnapshot>);

    const flags = collectEnabledInsecureOrDangerousFlags(
      asConfig({
        plugins: {
          entries: {
            acpx: {
              config: {
                permissionMode: "approve-all",
              },
            },
          },
        },
      }),
      { preferCurrentPluginMetadataSnapshot: true },
    );

    expect(flags).toContain("plugins.entries.acpx.config.permissionMode=approve-all");
    expect(resolvePluginConfigContractsById).not.toHaveBeenCalled();
  });
});
