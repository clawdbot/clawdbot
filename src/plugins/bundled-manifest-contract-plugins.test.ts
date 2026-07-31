// Verifies bundled manifest contract resolution honors explicit plugin scopes.
import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  loadManifestContractSnapshot: vi.fn(),
}));

vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestContractSnapshot: mocks.loadManifestContractSnapshot,
}));

const bundledContractPlugin = {
  id: "document-extract",
  enabledByDefault: true,
  channels: [],
  providers: [],
  cliBackends: [],
  skills: [],
  hooks: [],
  origin: "bundled",
  rootDir: "/tmp/document-extract",
  source: "bundled",
  manifestPath: "/tmp/document-extract/openclaw.plugin.json",
  contracts: {
    documentExtractors: ["pdf"],
  },
} satisfies PluginManifestRecord;

describe("resolveEnabledBundledManifestContractPlugins", () => {
  it("treats an explicit empty plugin scope as matching no contract owners", async () => {
    mocks.loadManifestContractSnapshot.mockReturnValue({
      plugins: [bundledContractPlugin],
    });
    const { resolveEnabledBundledManifestContractPlugins } =
      await import("./bundled-manifest-contract-plugins.js");

    expect(
      resolveEnabledBundledManifestContractPlugins({
        contract: "documentExtractors",
        compatMode: {
          enablement: "always",
          vitest: true,
        },
      }).map((plugin) => plugin.id),
    ).toStrictEqual(["document-extract"]);
    expect(
      resolveEnabledBundledManifestContractPlugins({
        onlyPluginIds: [],
        contract: "documentExtractors",
        compatMode: {
          enablement: "always",
          vitest: true,
        },
      }),
    ).toStrictEqual([]);
  });
});
