// List Prod Store Packages tests cover list prod store packages script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const scriptPath = resolve("scripts/list-prod-store-packages.mjs");
const tempDirs: string[] = [];

function runListProdStorePackages(input: unknown, cwd = process.cwd()) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

describe("list-prod-store-packages", () => {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });

  it("accepts pnpm list array output", () => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    const result = runListProdStorePackages(
      [
        {
          dependencies: {
            sourceMap: {
              from: "source-map",
              resolved: "https://registry.npmjs.org/source-map/-/source-map-0.6.1.tgz",
              version: "0.6.1",
            },
          },
        },
      ],
      cwd,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("source-map@0.6.1");
  });

  it("accepts pnpm list object output", () => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    const result = runListProdStorePackages(
      {
        dependencies: {
          litSignals: {
            from: "@lit-labs/signals",
            resolved: "https://registry.npmjs.org/@lit-labs/signals/-/signals-0.1.3.tgz",
            version: "0.1.3",
          },
        },
      },
      cwd,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("@lit-labs/signals@0.1.3");
  });

  it("adds lockfile snapshot dependencies missing from pnpm list output", () => {
    const cwd = makeTempRepoRoot(tempDirs, "openclaw-prod-store-packages-");
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(
      join(cwd, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '10.0'",
        "",
        "packages:",
        "  source-map-support@0.5.21:",
        "    resolution: {integrity: sha512-test}",
        "  source-map@0.6.1:",
        "    resolution: {integrity: sha512-test}",
        "",
        "snapshots:",
        "  source-map-support@0.5.21:",
        "    dependencies:",
        "      source-map: 0.6.1",
        "  source-map@0.6.1: {}",
        "",
      ].join("\n"),
    );
    const result = runListProdStorePackages(
      {
        dependencies: {
          sourceMapSupport: {
            from: "source-map-support",
            resolved:
              "https://registry.npmjs.org/source-map-support/-/source-map-support-0.5.21.tgz",
            version: "0.5.21",
          },
        },
      },
      cwd,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("source-map-support@0.5.21\nsource-map@0.6.1");
  });

  it("adds lockfile packages missing from pnpm list output", () => {
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
    const result = runListProdStorePackages({ dependencies: {} }, cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("recma-jsx@1.0.1");
  });
});
