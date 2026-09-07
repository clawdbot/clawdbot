// Release Check tests cover release check script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "tar";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectRootPackageExcludedExtensionDirs,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
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
  it("loads sparse release tooling and checks the target worker contract", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-target-"));
    try {
      const toolingRoot = join(root, "tooling");
      const workflow = parse(readFileSync(".github/workflows/openclaw-npm-preflight.yml", "utf8"));
      const checkout = workflow.jobs.check_contents_npm.steps.find(
        (step: { name?: string }) => step.name === "Checkout trusted Plugin SDK API tooling",
      );
      const sparseRoots = checkout.with["sparse-checkout"].trim().split(/\s+/u) as string[];
      const trackedPaths = execFileSync(
        "git",
        ["ls-files", "-z", "--", ":(top,glob)*", ...sparseRoots],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      )
        .split("\0")
        .filter(Boolean);
      for (const relativePath of trackedPaths) {
        const destination = join(toolingRoot, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(relativePath, destination);
      }
      symlinkSync(resolve("node_modules"), join(toolingRoot, "node_modules"), "junction");
      mkdirSync(join(root, "scripts", "lib"), { recursive: true });
      mkdirSync(join(root, "extensions"));
      const packageJson = JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        files: ["dist"],
      });
      writeFileSync(join(root, "package.json"), packageJson);
      mkdirSync(join(root, "scripts", "fixtures"), { recursive: true });
      writeFileSync(
        join(root, "scripts/fixtures/packed-plugin-sdk-type-smoke.ts"),
        "stale target fixture",
      );
      const moduleUrl = pathToFileURL(join(toolingRoot, "scripts/release-check.ts")).href;
      const runtimeArgs = process.versions.bun
        ? []
        : ["--import", join(toolingRoot, "scripts/tsx.mjs")];
      const output = execFileSync(
        process.execPath,
        [
          ...runtimeArgs,
          "--input-type=module",
          "--eval",
          `import { readFileSync } from "node:fs";\n` +
            `const { createPackedPluginSdkTypescriptSmokeProject } = await import(${JSON.stringify(moduleUrl)});\n` +
            `createPackedPluginSdkTypescriptSmokeProject({ consumerDir: "consumer", packageSpec: "file:fixture.tgz" });\n` +
            `console.log(JSON.stringify({ fixture: readFileSync("consumer/src/index.ts", "utf8") }));`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
        },
      );
      expect(JSON.parse(output)).toEqual({
        fixture: readFileSync(
          join(toolingRoot, "scripts/fixtures/packed-plugin-sdk-type-smoke.ts"),
          "utf8",
        ),
      });

      copyFileSync("appcast.xml", join(root, "appcast.xml"));
      mkdirSync(join(root, "src/shared"), { recursive: true });
      mkdirSync(join(root, "src/worker"), { recursive: true });
      writeFileSync(join(root, "src/worker/worker-deploy-entry.ts"), "export {};\n");
      const packedRoot = join(root, "package");
      const packedFiles = {
        "package.json": packageJson,
        "dist/entry.js": 'import "./cli/run-main.js";',
        "dist/cli/run-main.js": "export {};",
        "dist/run-gateway.js": "const GATEWAY_AUTH_MODES = []; function addGatewayRunCommand() {}",
        "dist/worker/worker.mjs": "export {};",
        "dist/worker/workspace-rsync-receiver.mjs": "export {};",
      };
      for (const [relativePath, source] of Object.entries(packedFiles)) {
        const destination = join(packedRoot, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, source);
      }
      const tarball = join(root, "target.tgz");
      const cases = [
        {
          declaresLauncher: false,
          declaresLocator: false,
          includesLocator: false,
          expected: "release-check: packed dist/plugin-sdk directory not found.",
        },
        {
          declaresLauncher: true,
          declaresLocator: false,
          includesLocator: false,
          expected: "Worker deploy artifact dist/worker/github-exec-launcher.mjs is missing.",
        },
        {
          declaresLauncher: false,
          declaresLocator: true,
          includesLocator: false,
          expected: "could not read gateway run chunk metadata",
        },
        {
          declaresLauncher: false,
          declaresLocator: true,
          includesLocator: true,
          expected: "release-check: packed dist/plugin-sdk directory not found.",
        },
      ];
      for (const { declaresLauncher, declaresLocator, includesLocator, expected } of cases) {
        const locatorSource = join(root, "scripts/lib/gateway-run-chunk-metadata.mts");
        if (declaresLocator) {
          writeFileSync(locatorSource, "export const GATEWAY_RUN_CHUNK_METADATA_VERSION = 1;");
        } else {
          rmSync(locatorSource, { force: true });
        }
        if (includesLocator) {
          writeFileSync(
            join(packedRoot, "dist/cli/gateway-run-chunk.json"),
            JSON.stringify({
              version: 1,
              chunks: [
                {
                  fileName: "run-gateway.js",
                  sha256: createHash("sha256")
                    .update(packedFiles["dist/run-gateway.js"])
                    .digest("hex"),
                },
              ],
            }),
          );
        }
        create({ cwd: root, file: tarball, gzip: true, sync: true }, ["package"]);
        writeFileSync(
          join(root, "src/shared/worker-bundle-hash.ts"),
          'export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";\n' +
            'export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";\n' +
            (declaresLauncher
              ? 'export const WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH = "github-exec-launcher.mjs";\n'
              : ""),
        );
        const result = spawnSync(
          process.execPath,
          [...runtimeArgs, join(toolingRoot, "scripts/release-check.ts"), "--tarball", tarball],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
          },
        );
        expect(result.status).toBe(1);
        // Valid target-specific artifacts reach the SDK check; this fixture omits SDK output.
        expect(result.stderr).toContain(expected);
      }

      writeFileSync(
        join(root, "src/shared/worker-bundle-hash.ts"),
        'export const WORKER_BUNDLE_ENTRY_PATH = "";\n',
      );
      const emptyPathResult = spawnSync(
        process.execPath,
        [...runtimeArgs, join(toolingRoot, "scripts/release-check.ts"), "--tarball", tarball],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
        },
      );
      expect(emptyPathResult.status).toBe(1);
      expect(emptyPathResult.stderr).toContain(
        "release-check: target worker artifact WORKER_BUNDLE_ENTRY_PATH must be a non-empty path string.",
      );

      writeFileSync(
        join(root, "src/shared/worker-bundle-hash.ts"),
        'export const WORKER_BUNDLE_ENTRY_PATH = "../worker/main.mjs";\n',
      );
      const escapingPathResult = spawnSync(
        process.execPath,
        [...runtimeArgs, join(toolingRoot, "scripts/release-check.ts"), "--tarball", tarball],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
        },
      );
      expect(escapingPathResult.status).toBe(1);
      expect(escapingPathResult.stderr).toContain(
        "release-check: target worker artifact WORKER_BUNDLE_ENTRY_PATH must be a normalized relative path within dist/worker.",
      );

      writeFileSync(
        join(root, "src/shared/worker-bundle-hash.ts"),
        "export const OTHER_PATH = 1;\n",
      );
      const missingContractResult = spawnSync(
        process.execPath,
        [
          "--import",
          join(toolingRoot, "scripts/tsx.mjs"),
          join(toolingRoot, "scripts/release-check.ts"),
          "--tarball",
          tarball,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
        },
      );
      expect(missingContractResult.status).toBe(1);
      expect(missingContractResult.stderr).toContain(
        "release-check: target worker producer is missing WORKER_BUNDLE_*_PATH declarations.",
      );

      // Shared worker helpers predate the deploy producer and cannot define the
      // package contract for those historical frozen targets.
      rmSync(join(root, "src/worker/worker-deploy-entry.ts"));
      rmSync(join(packedRoot, "dist/worker"), { recursive: true, force: true });
      const noWorkerTarball = join(root, "target-without-workers.tgz");
      create({ cwd: root, file: noWorkerTarball, gzip: true, sync: true }, ["package"]);
      const noWorkerResult = spawnSync(
        process.execPath,
        [
          "--import",
          join(toolingRoot, "scripts/tsx.mjs"),
          join(toolingRoot, "scripts/release-check.ts"),
          "--tarball",
          noWorkerTarball,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
        },
      );
      expect(noWorkerResult.status).toBe(1);
      expect(noWorkerResult.stderr).toContain(
        "release-check: packed dist/plugin-sdk directory not found.",
      );
      expect(noWorkerResult.stderr).not.toContain("Worker deploy artifact");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs the prepared tarball with its real package lifecycle", () => {
    expect(createPackedTarballInstallArgs("/tmp/prefix")).toEqual([
      "install",
      "--prefix",
      "/tmp/prefix",
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

      const pluginEntries = requirePluginEntries(config);
      const channels = Object.keys(config.channels ?? {});
      expect(channels.length).toBeGreaterThan(0);
      const excluded = collectRootPackageExcludedExtensionDirs();
      const artifacts = listBundledPluginPackArtifacts();
      for (const channel of channels) {
        expect(pluginEntries).toHaveProperty(channel);
        expect(excluded.has(channel)).toBe(false);
        const manifest = JSON.parse(
          readFileSync(join("extensions", channel, "openclaw.plugin.json"), "utf8"),
        ) as { channels: string[] };
        expect(manifest.channels).toContain(channel);
        expect(artifacts).toContain(`dist/extensions/${channel}/openclaw.plugin.json`);
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
