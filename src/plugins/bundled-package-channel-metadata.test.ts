import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";

vi.mock("./bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
}));

import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { findBundledPackageChannelMetadata } from "./bundled-package-channel-metadata.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

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
    vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);

    const matrix = findBundledPackageChannelMetadata("matrix");

    expect(matrix?.doctorCapabilities).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });
});
