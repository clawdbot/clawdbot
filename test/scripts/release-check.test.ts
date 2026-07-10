// Release Check tests cover release check script behavior.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPackedTarballInstallArgs,
  prepareReleaseCheckLocalPackageTarballs,
  RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
  resolveReleaseCheckLocalPackageTarballs,
  writePackedTarballInstallManifest,
  writePackedBundledPluginActivationConfig,
} from "../../scripts/release-check.ts";

function requirePluginEntries(config: { plugins?: { entries?: Record<string, unknown> } }) {
  if (!config.plugins?.entries) {
    throw new Error("Expected plugin entries in packaged activation config");
  }
  return config.plugins.entries;
}

describe("release-check", () => {
  it("installs the packed core and local sibling package tarballs together", () => {
    expect(createPackedTarballInstallArgs("/tmp/prefix")).toEqual([
      "install",
      "--prefix",
      "/tmp/prefix",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("resolves exactly one prepacked local dependency tarball", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      writeFileSync(join(root, "openclaw-ai-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "SHA256SUMS"), "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root)).toEqual([
        join(root, "openclaw-ai-2026.6.33.tgz"),
      ]);
      expect(resolveReleaseCheckLocalPackageTarballs(undefined)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an explicit local project for unpublished core and AI tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", ["/tmp/openclaw-ai.tgz"]);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        private?: boolean;
      };
      expect(manifest.private).toBe(true);
      expect(manifest.dependencies).toEqual({
        "@openclaw/ai": "file:///tmp/openclaw-ai.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs the local AI workspace when no prepared tarball is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        packLocalAi: (packDestination) => {
          const filename = "openclaw-ai-2026.7.1-beta.3.tgz";
          writeFileSync(join(packDestination, filename), "fixture");
          return [{ filename }];
        },
      });
      expect(tarballs).toEqual([join(root, "ai-pack", "openclaw-ai-2026.7.1-beta.3.tgz")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the prepared AI tarball over packing the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const preparedDir = join(root, "prepared");
      mkdirSync(preparedDir);
      const preparedTarball = join(preparedDir, "openclaw-ai-2026.7.1-beta.3.tgz");
      writeFileSync(preparedTarball, "fixture");
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        tarballDir: preparedDir,
        packLocalAi: () => {
          throw new Error("workspace pack should not run");
        },
      });
      expect(tarballs).toEqual([preparedTarball]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a packed install without the local AI tarball", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      expect(() => writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [])).toThrow(
        "requires exactly one @openclaw/ai tarball",
      );
      expect(() =>
        writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [
          "/tmp/openclaw-ai-one.tgz",
          "/tmp/openclaw-ai-two.tgz",
        ]),
      ).toThrow("requires exactly one @openclaw/ai tarball");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, empty, or ambiguous local dependency tarball directories", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      expect(() => resolveReleaseCheckLocalPackageTarballs(join(root, "missing"))).toThrow(
        RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
      );
      const empty = join(root, "empty");
      mkdirSync(empty);
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow("contains 0 tarballs");
      writeFileSync(join(empty, "one.tgz"), "fixture");
      writeFileSync(join(empty, "two.tgz"), "fixture");
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow("contains 2 tarballs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds packaged activation smoke with an included channel plugin", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openclaw-release-check-test-"));
    try {
      writePackedBundledPluginActivationConfig(homeDir);
      const config = JSON.parse(
        readFileSync(join(homeDir, ".openclaw", "openclaw.json"), "utf8"),
      ) as {
        channels?: Record<string, unknown>;
        plugins?: { entries?: Record<string, unknown> };
      };

      expect(config.channels).toHaveProperty("matrix");
      const pluginEntries = requirePluginEntries(config);
      expect(pluginEntries).toHaveProperty("matrix");
      expect(config.channels).not.toHaveProperty("feishu");
      expect(pluginEntries).not.toHaveProperty("feishu");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
