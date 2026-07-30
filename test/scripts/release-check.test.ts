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

  it("resolves prepacked publishable core package tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      writeFileSync(join(root, "openclaw-ai-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "openclaw-gateway-client-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "openclaw-gateway-protocol-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "SHA256SUMS"), "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root)).toEqual([
        join(root, "openclaw-ai-2026.6.33.tgz"),
        join(root, "openclaw-gateway-client-2026.6.33.tgz"),
        join(root, "openclaw-gateway-protocol-2026.6.33.tgz"),
      ]);
      expect(resolveReleaseCheckLocalPackageTarballs(undefined)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts gateway core packages when the root does not require AI", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      const gatewayTarball = join(root, "openclaw-gateway-protocol-2026.7.2.tgz");
      const gatewayClientTarball = join(root, "openclaw-gateway-client-2026.7.2.tgz");
      writeFileSync(gatewayTarball, "fixture");
      writeFileSync(gatewayClientTarball, "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root, false)).toEqual([
        gatewayClientTarball,
        gatewayTarball,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an explicit local project for unpublished core package tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [
        "/tmp/openclaw-ai.tgz",
        "/tmp/openclaw-gateway-client.tgz",
        "/tmp/openclaw-gateway-protocol.tgz",
      ]);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        private?: boolean;
      };
      expect(manifest.private).toBe(true);
      expect(manifest.dependencies).toEqual({
        "@openclaw/ai": "file:///tmp/openclaw-ai.tgz",
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a gateway-packages-only local project when the root does not require AI", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(
        root,
        "/tmp/openclaw.tgz",
        ["/tmp/openclaw-gateway-client.tgz", "/tmp/openclaw-gateway-protocol.tgz"],
        false,
      );
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies).toEqual({
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
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

  it("prefers prepared core package tarballs over packing the AI workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const preparedDir = join(root, "prepared");
      mkdirSync(preparedDir);
      const preparedTarball = join(preparedDir, "openclaw-ai-2026.7.1-beta.3.tgz");
      const gatewayProtocolTarball = join(
        preparedDir,
        "openclaw-gateway-protocol-2026.7.1-beta.3.tgz",
      );
      const gatewayClientTarball = join(preparedDir, "openclaw-gateway-client-2026.7.1-beta.3.tgz");
      writeFileSync(preparedTarball, "fixture");
      writeFileSync(gatewayClientTarball, "fixture");
      writeFileSync(gatewayProtocolTarball, "fixture");
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        tarballDir: preparedDir,
        packLocalAi: () => {
          throw new Error("workspace pack should not run");
        },
      });
      expect(tarballs).toEqual([preparedTarball, gatewayClientTarball, gatewayProtocolTarball]);
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

  it("rejects missing, incomplete, or ambiguous local package tarball directories", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      expect(() => resolveReleaseCheckLocalPackageTarballs(join(root, "missing"))).toThrow(
        RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
      );
      const empty = join(root, "empty");
      mkdirSync(empty);
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow(
        "must contain exactly one @openclaw/ai tarball",
      );
      writeFileSync(join(empty, "one.tgz"), "fixture");
      writeFileSync(join(empty, "two.tgz"), "fixture");
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow(
        "contains an unsupported package tarball",
      );
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
