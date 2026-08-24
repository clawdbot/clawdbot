// Verifies bundled package channel metadata stays aligned with catalogs.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";

vi.mock("./bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
}));

import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { listBundledPackageChannelMetadata } from "./bundled-package-channel-metadata.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
  }
  cleanupTempDirs(tempDirs);
  clearPluginMetadataLifecycleCaches();
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

function useBundledPluginsDir(extensionsRoot: string): void {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = extensionsRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);
}

describe("bundled package channel metadata", () => {
  it("reads doctor capabilities from the resolved bundled plugin dir", () => {
    const root = makeTempRepoRoot(tempDirs, "bpcm-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    writeJsonFile(path.join(extensionsRoot, "matrix", "package.json"), {
      name: "@openclaw/matrix",
      openclaw: {
        channel: {
          id: "matrix",
          label: "Matrix",
          docsPath: "/channels/matrix",
          doctorCapabilities: {
            dmAllowFromMode: "nestedOnly",
            groupModel: "sender",
            groupAllowFromFallbackToAllowFrom: false,
            warnOnEmptyGroupSenderAllowlist: true,
          },
        },
      },
    });
    writeJsonFile(path.join(extensionsRoot, "matrix", "openclaw.plugin.json"), {
      id: "matrix",
      configSchema: { type: "object" },
      channels: ["matrix"],
    });
    fs.writeFileSync(
      path.join(extensionsRoot, "matrix", "index.js"),
      "export default {};\n",
      "utf8",
    );
    useBundledPluginsDir(extensionsRoot);

    const matrix = listBundledPackageChannelMetadata().find((channel) => channel.id === "matrix");

    expect(matrix?.doctorCapabilities).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("reflects package channel metadata edits after the metadata lifecycle is cleared", () => {
    const root = makeTempRepoRoot(tempDirs, "bpcm-fresh-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    const packagePath = path.join(extensionsRoot, "matrix", "package.json");
    useBundledPluginsDir(extensionsRoot);

    writeJsonFile(packagePath, {
      name: "@openclaw/matrix",
      openclaw: {
        channel: {
          id: "matrix",
          label: "Before",
        },
      },
    });
    writeJsonFile(path.join(extensionsRoot, "matrix", "openclaw.plugin.json"), {
      id: "matrix",
      configSchema: { type: "object" },
      channels: ["matrix"],
    });
    fs.writeFileSync(
      path.join(extensionsRoot, "matrix", "index.js"),
      "export default {};\n",
      "utf8",
    );
    expect(
      listBundledPackageChannelMetadata().find((channel) => channel.id === "matrix")?.label,
    ).toBe("Before");

    writeJsonFile(packagePath, {
      name: "@openclaw/matrix",
      openclaw: {
        channel: {
          id: "matrix",
          label: "After",
        },
      },
    });

    clearPluginMetadataLifecycleCaches();
    expect(
      listBundledPackageChannelMetadata().find((channel) => channel.id === "matrix")?.label,
    ).toBe("After");
  });
});
