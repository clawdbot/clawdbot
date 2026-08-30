// Verifies cold retired-profile policy resolution for trusted external providers.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const fixtureState = vi.hoisted(() => ({ pluginRoot: "" }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const externalPluginRoot = tempDirs.make("openclaw-provider-retired-auth-external-");
fs.writeFileSync(
  path.join(externalPluginRoot, "provider-policy-api.js"),
  'export const deprecatedProfileIds = ["fixture-provider:legacy"];\n',
  "utf8",
);
fixtureState.pluginRoot = externalPluginRoot;

vi.mock("./current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => ({
    manifestRegistry: {
      plugins: [
        {
          id: "fixture-provider",
          origin: "external",
          trustedOfficialInstall: true,
          rootDir: fixtureState.pluginRoot,
          providers: ["fixture-provider"],
          cliBackends: [],
        },
      ],
    },
  }),
  isScopedPluginMetadataSnapshotRuntimeGeneration: () => false,
}));

const { resolveProviderDeprecatedAuthProfileIds } = await import("./provider-runtime.js");

describe("trusted external provider retired auth policy", () => {
  it("resolves retired profile ids while the provider runtime remains cold", () => {
    expect(resolveProviderDeprecatedAuthProfileIds({ provider: "fixture-provider" })).toEqual([
      "fixture-provider:legacy",
    ]);
  });
});
