// List Prod Store Packages tests cover list prod store packages script behavior.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";

const scriptPath = resolve("scripts/list-prod-store-packages.mjs");
const tempDirs: string[] = [];

function runListProdStorePackages(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
  });
}

describe("list-prod-store-packages", () => {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });

  it.each([false, true])("adds production closures with toolchain metadata %s", (withToolchain) => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    writeFileSync(
      join(cwd, "pnpm-lock.yaml"),
      [
        ...(withToolchain
          ? [
              "---",
              "lockfileVersion: '9.0'",
              "importers:",
              "  .:",
              "    packageManagerDependencies:",
              "      pnpm: {specifier: 12.0.0, version: 12.0.0}",
              "packages:",
              "  pnpm@12.0.0: {}",
              "snapshots:",
              "  pnpm@12.0.0: {}",
              "---",
            ]
          : []),
        "lockfileVersion: '10.0'",
        "",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@homebridge/ciao':",
        "        specifier: 1.3.9",
        "        version: 1.3.9",
        "      fetch-blob:",
        "        specifier: 3.2.0",
        "        version: 3.2.0",
        "",
        "packages:",
        "  '@homebridge/ciao@1.3.9':",
        "    resolution: {integrity: sha512-test}",
        "  source-map-support@0.5.21:",
        "    resolution: {integrity: sha512-test}",
        "  source-map@0.6.1:",
        "    resolution: {integrity: sha512-test}",
        "  fetch-blob@3.2.0:",
        "    resolution: {integrity: sha512-test}",
        "  '@nolyfill/domexception@1.0.28':",
        "    resolution: {integrity: sha512-test}",
        "",
        "snapshots:",
        "  '@homebridge/ciao@1.3.9':",
        "    dependencies:",
        "      source-map-support: 0.5.21",
        "  source-map-support@0.5.21:",
        "    dependencies:",
        "      source-map: 0.6.1",
        "  source-map@0.6.1: {}",
        "  fetch-blob@3.2.0:",
        "    dependencies:",
        "      node-domexception: '@nolyfill/domexception@1.0.28'",
        "  '@nolyfill/domexception@1.0.28': {}",
        "",
      ].join("\n"),
    );
    const result = runListProdStorePackages(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual(
      [
        "@homebridge/ciao@1.3.9",
        "fetch-blob@3.2.0",
        "@nolyfill/domexception@1.0.28",
        "source-map-support@0.5.21",
        "source-map@0.6.1",
      ].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("adds target optional dependencies from peer-resolved lockfile snapshots", () => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    const platformPackages = [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "arm64"],
      ["win32", "x64"],
    ] as const;
    writeFileSync(
      join(cwd, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '10.0'",
        "",
        "importers:",
        "  .:",
        "    dependencies:",
        "      'native-wrapper':",
        "        version: '1.0.0(peer@1.0.0)'",
        "packages:",
        "  native-wrapper@1.0.0:",
        "    resolution: {integrity: sha512-test}",
        ...platformPackages.flatMap(([os, cpu]) => [
          `  native-wrapper-${os}-${cpu}@1.0.0:`,
          "    resolution: {integrity: sha512-test}",
          `    cpu: [${cpu}]`,
          `    os: [${os}]`,
        ]),
        "",
        "snapshots:",
        "  native-wrapper@1.0.0(peer@1.0.0):",
        "    optionalDependencies:",
        ...platformPackages.map(([os, cpu]) => `      native-wrapper-${os}-${cpu}: 1.0.0`),
        ...platformPackages.flatMap(([os, cpu]) => [
          `  native-wrapper-${os}-${cpu}@1.0.0:`,
          "    optional: true",
        ]),
        "",
      ].join("\n"),
    );
    const result = runListProdStorePackages(cwd);

    expect(result.status).toBe(0);
    const expectedPlatformPackage = [`native-wrapper-${process.platform}-${process.arch}@1.0.0`];
    const supportedPlatformPackage = ["linux", "darwin", "win32"].includes(process.platform)
      ? expectedPlatformPackage
      : [];
    expect(result.stdout.split("\n").filter(Boolean)).toEqual(
      ["native-wrapper@1.0.0", ...supportedPlatformPackage].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("does not add packages outside production importer closures", () => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    writeFileSync(
      join(cwd, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '10.0'",
        "",
        "packages:",
        "  recma-jsx@1.0.1(acorn@8.16.0):",
        "    resolution: {integrity: sha512-test}",
        "",
        "snapshots: {}",
        "",
      ].join("\n"),
    );
    const result = runListProdStorePackages(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("only adds optional platform packages matching the current target", () => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    const platformPackages = [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "arm64"],
      ["win32", "x64"],
    ] as const;
    const expectedPlatformPackage = platformPackages
      .map(([os, cpu]) => `@zed-industries/codex-acp-${os}-${cpu}@0.15.0`)
      .find(
        (spec) => spec === `@zed-industries/codex-acp-${process.platform}-${process.arch}@0.15.0`,
      );
    writeFileSync(
      join(cwd, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '10.0'",
        "",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@zed-industries/codex-acp':",
        "        version: '0.15.0'",
        "packages:",
        "  '@zed-industries/codex-acp@0.15.0':",
        "    resolution: {integrity: sha512-test}",
        ...platformPackages.flatMap(([os, cpu]) => [
          `  '@zed-industries/codex-acp-${os}-${cpu}@0.15.0':`,
          "    resolution: {integrity: sha512-test}",
          `    cpu: [${cpu}]`,
          `    os: [${os}]`,
        ]),
        "",
        "snapshots:",
        "  '@zed-industries/codex-acp@0.15.0':",
        "    optionalDependencies:",
        ...platformPackages.map(
          ([os, cpu]) => `      '@zed-industries/codex-acp-${os}-${cpu}': 0.15.0`,
        ),
        ...platformPackages.flatMap(([os, cpu]) => [
          `  '@zed-industries/codex-acp-${os}-${cpu}@0.15.0':`,
          "    optional: true",
        ]),
        "",
      ].join("\n"),
    );
    const result = runListProdStorePackages(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toEqual(
      [expectedPlatformPackage, "@zed-industries/codex-acp@0.15.0"].filter(Boolean),
    );
  });
});
