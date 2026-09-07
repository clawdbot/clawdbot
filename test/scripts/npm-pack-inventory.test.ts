import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectNpmPackInventory,
  compareNpmPackInventory,
} from "../../scripts/lib/npm-pack-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createPackageFixture(): { packageRoot: string; root: string } {
  const root = tempDirs.make("openclaw-npm-pack-inventory-test-");
  const packageRoot = join(root, "package");
  mkdirSync(packageRoot);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "inventory-fixture", version: "1.0.0" }),
  );
  return { packageRoot, root };
}

function fakeNpmEnvironment(
  root: string,
  body: string,
): {
  runnerParams: { execPath: string; platform: NodeJS.Platform };
  sourceEnv: NodeJS.ProcessEnv;
} {
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const scriptPath = join(binDir, "fake-npm.mjs");
  writeFileSync(scriptPath, body);
  if (process.platform === "win32") {
    writeFileSync(
      join(binDir, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
  } else {
    const wrapperPath = join(binDir, "npm");
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    chmodSync(wrapperPath, 0o755);
  }
  return {
    runnerParams: {
      execPath: join(binDir, process.platform === "win32" ? "node.exe" : "node"),
      platform: process.platform,
    },
    sourceEnv: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

describe("npm pack inventory", () => {
  it("packs the package root from an isolated npm sandbox", () => {
    const { packageRoot, root } = createPackageFixture();
    const capturePath = join(root, "capture.json");
    const npm = fakeNpmEnvironment(
      root,
      [
        "import fs from 'node:fs';",
        "fs.appendFileSync(process.env.OPENCLAW_TEST_CAPTURE, JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  home: process.env.HOME,",
        "  npmConfigKeys: Object.keys(process.env).filter((key) => /^npm_config_/i.test(key)).sort(),",
        "}) + '\\n');",
        "if (process.argv.includes('--version')) { process.stdout.write('11.12.1\\n'); process.exit(0); }",
        "process.stdout.write(JSON.stringify([{ files: [{ path: 'package.json' }] }]));",
      ].join("\n"),
    );
    npm.sourceEnv.OPENCLAW_TEST_CAPTURE = capturePath;
    npm.sourceEnv.npm_config_registry = "https://example.invalid";
    npm.sourceEnv.NPM_CONFIG_SCRIPT_SHELL = "forbidden-shell";

    const result = collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 });
    const captures = readFileSync(capturePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      args: string[];
      cwd: string;
      home: string;
      npmConfigKeys: string[];
    }>;

    expect(result).toMatchObject({ files: ["package.json"], npmVersion: "11.12.1" });
    expect(captures).toHaveLength(2);
    const [versionCapture, packCapture] = captures;
    if (!versionCapture || !packCapture) {
      throw new Error("Expected npm version and pack captures.");
    }
    expect(packCapture.cwd).toBe(versionCapture.cwd);
    expect(packCapture.cwd).not.toBe(packageRoot);
    expect(versionCapture.args).toEqual([`--prefix=${versionCapture.cwd}`, "--version"]);
    expect(packCapture.args.slice(0, 3)).toEqual([
      `--prefix=${versionCapture.cwd}`,
      "pack",
      packageRoot,
    ]);
    expect(packCapture.home).not.toBe(process.env.HOME);
    expect(packCapture.npmConfigKeys).not.toContain("npm_config_registry");
    expect(packCapture.npmConfigKeys).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(packCapture.args).toEqual(
      expect.arrayContaining([
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--offline",
        "--workspaces=false",
      ]),
    );
  });

  it("reports missing and extra paths in normalized sorted order", () => {
    expect(
      compareNpmPackInventory(
        ["package.json", "dist/extra.js"],
        ["package.json", "dist/missing.js"],
      ),
    ).toEqual({
      extra: ["dist/extra.js"],
      missing: ["dist/missing.js"],
    });
  });

  it("excludes host-npm-version-variant paths from inventory parity", () => {
    expect(
      compareNpmPackInventory(
        ["package.json", "npm-shrinkwrap.json"],
        ["package.json"],
        ["npm-shrinkwrap.json"],
      ),
    ).toEqual({ extra: [], missing: [] });
  });

  it("accepts npm 12 name-keyed package results", () => {
    const { packageRoot, root } = createPackageFixture();
    const npm = fakeNpmEnvironment(
      root,
      [
        "if (process.argv.includes('--version')) { process.stdout.write('12.0.2\\n'); process.exit(0); }",
        `process.stdout.write(JSON.stringify({ "inventory-fixture": { files: [{ path: "package.json" }, { path: "./dist/index.js" }] } }));`,
      ].join("\n"),
    );

    expect(collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 })).toMatchObject({
      files: ["dist/index.js", "package.json"],
      npmVersion: "12.0.2",
    });
  });

  it.each([
    { name: "successful pack", exitCode: 0 },
    { name: "failed pack", exitCode: 23 },
  ])(
    "suppresses npm 10 lifecycle scripts and restores package.json after $name",
    ({ exitCode }) => {
      const { packageRoot, root } = createPackageFixture();
      const packageJsonPath = join(packageRoot, "package.json");
      const capturePath = join(root, "scripts-capture.json");
      const originalBytes = Buffer.from(
        '{\n\t"version" : "1.0.0",\n\t"scripts" : { "prepack" : "exit 99" },\n\t"name" : "inventory-fixture"\n}\n',
      );
      writeFileSync(packageJsonPath, originalBytes);
      chmodSync(packageJsonPath, 0o444);
      const originalMode = statSync(packageJsonPath).mode;
      const npm = fakeNpmEnvironment(
        root,
        [
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "if (process.argv.includes('--version')) { process.stdout.write('10.9.4\\n'); process.exit(0); }",
          "const packIndex = process.argv.indexOf('pack');",
          "const packageRoot = process.argv[packIndex + 1];",
          "const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));",
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CAPTURE, JSON.stringify({ hasScripts: Object.hasOwn(packageJson, 'scripts') }));",
          exitCode === 0
            ? "process.stdout.write(JSON.stringify([{ files: [{ path: 'package.json' }] }]));"
            : `process.stderr.write('simulated npm 10 failure\\n'); process.exit(${exitCode});`,
        ].join("\n"),
      );
      npm.sourceEnv.OPENCLAW_TEST_CAPTURE = capturePath;

      if (exitCode === 0) {
        expect(collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 })).toMatchObject({
          files: ["package.json"],
          npmVersion: "10.9.4",
        });
      } else {
        expect(() => collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 })).toThrow(
          "npm pack inventory failed: simulated npm 10 failure",
        );
      }

      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({ hasScripts: false });
      expect(readFileSync(packageJsonPath)).toEqual(originalBytes);
      expect(statSync(packageJsonPath).mode).toBe(originalMode);
    },
  );

  it.each([
    {
      name: "malformed JSON",
      body: "process.stdout.write('{');",
      error: "npm pack returned invalid JSON",
    },
    {
      name: "multiple package results",
      body: `process.stdout.write(JSON.stringify([{ files: [] }, { files: [] }]));`,
      error: "npm pack JSON must contain exactly one package result",
    },
    {
      name: "duplicate paths",
      body: `process.stdout.write(JSON.stringify([{ files: [{ path: "package.json" }, { path: "package.json" }] }]));`,
      error: "npm pack returned duplicate package path package.json",
    },
  ])("fails closed on $name", ({ body, error }) => {
    const { packageRoot, root } = createPackageFixture();
    const npm = fakeNpmEnvironment(
      root,
      [
        "if (process.argv.includes('--version')) { process.stdout.write('11.12.1\\n'); process.exit(0); }",
        body,
      ].join("\n"),
    );

    expect(() => collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 })).toThrow(error);
  });

  it("fails closed when npm is missing", () => {
    const { packageRoot, root } = createPackageFixture();
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    expect(() =>
      collectNpmPackInventory(packageRoot, {
        runnerParams: {
          execPath: join(emptyBin, process.platform === "win32" ? "node.exe" : "node"),
          platform: process.platform,
        },
        sourceEnv: { ...process.env, PATH: emptyBin },
        timeoutMs: 2_000,
      }),
    ).toThrow(
      /(?:npm --version executable was not found|failed to resolve a toolchain-local npm)/u,
    );
  });

  it("fails closed when npm pack times out", () => {
    const { packageRoot, root } = createPackageFixture();
    const npm = fakeNpmEnvironment(
      root,
      [
        "if (process.argv.includes('--version')) { process.stdout.write('11.12.1\\n'); process.exit(0); }",
        "setTimeout(() => process.stdout.write(JSON.stringify([{ files: [] }])), 10_000);",
      ].join("\n"),
    );

    expect(() => collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 1_000 })).toThrow(
      "npm pack inventory timed out after 1000ms",
    );
  });
});
