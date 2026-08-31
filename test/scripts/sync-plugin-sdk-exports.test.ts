import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmJsonEntries } from "../../scripts/lib/npm-json-output.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const declarationConfigs = [
  { file: "extensions/tsconfig.package-boundary.paths.json", prefix: "../" },
  { file: "extensions/xai/tsconfig.json", prefix: "../../" },
] as const;
const outputFiles = [
  "package.json",
  "packages/plugin-sdk/package.json",
  ...declarationConfigs.map(({ file }) => file),
];
const entryList = "scripts/lib/plugin-sdk-entrypoints.json";
const privateList = "scripts/lib/plugin-sdk-private-local-only-subpaths.json";
const fixtureFiles = [
  "dist/",
  "assets/",
  "!assets/internal.txt",
  "!dist/plugin-sdk/nested/internal.d.ts",
  "!dist/plugin-sdk/owner-*.js",
  "!dist/plugin-sdk/owner-?.js",
  "!dist/plugin-sdk/owner-[ab].js",
  "!dist/plugin-sdk/owner-{a,b}.js",
  "!dist/plugin-sdk/owner-@(a|b).js",
  "!dist/**/*.map",
  "!dist/plugin-sdk/.tsbuildinfo",
  "!dist/plugin-sdk/qa-lab.*",
  "!dist/plugin-sdk/owner_entry.json",
];
const literalEntries = ["private-entry", "private_entry", "Private.entry-Ü"];

function writeJson(root: string, file: string, value: unknown) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function readConfig(
  root: string,
  file: string,
): {
  compilerOptions: { paths: Record<string, string[]> };
} {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function readOutputs(root: string) {
  return outputFiles.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
}

function readPackage(root: string): { exports: Record<string, unknown>; files: string[] } {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

function createFixture(inventory?: { entries: string[]; privateEntries: string[] }) {
  const root = tempDirs.make("openclaw-sdk-registration-");
  for (const file of [
    "scripts/sync-plugin-sdk-exports.mts",
    "scripts/lib/plugin-sdk-entries.mts",
    entryList,
    privateList,
    "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
    "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
    ...outputFiles,
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, "packages/plugin-sdk/src"), { recursive: true });
  if (inventory) {
    writeJson(root, entryList, inventory.entries);
    writeJson(root, privateList, inventory.privateEntries);
    writeJson(root, "package.json", {
      name: "sdk-registration-fixture",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.js" },
      files: fixtureFiles,
    });
    writeJson(root, "packages/plugin-sdk/package.json", { exports: {} });
    for (const { file, prefix } of declarationConfigs) {
      writeJson(root, file, {
        extends: "./base.json",
        compilerOptions: {
          strict: true,
          paths: {
            "openclaw/plugin-sdk/*": [`${prefix}dist/plugin-sdk/*.d.ts`],
            "openclaw/plugin-sdk/custom": [
              `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/custom.d.ts`,
              "./override.d.ts",
            ],
          },
        },
        include: ["z.ts", "a.ts"],
      });
    }
  } else {
    // Registration reads facade names, not their implementation or dependencies.
    for (const file of fs.readdirSync(path.join(repoRoot, "packages/plugin-sdk/src"))) {
      if (file.endsWith(".ts")) {
        fs.writeFileSync(path.join(root, "packages/plugin-sdk/src", file), "");
      }
    }
  }
  return root;
}

function runSync(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repoRoot, "scripts/tsx.mjs"),
      path.join(root, "scripts/sync-plugin-sdk-exports.mts"),
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function expectStableSync(root: string) {
  const synced = readOutputs(root);
  for (const args of [[], ["--check"]]) {
    const result = runSync(root, ...args);
    expect(result.status, result.stderr).toBe(0);
    expect(readOutputs(root)).toEqual(synced);
  }
}

describe("plugin SDK registration CLI", () => {
  it("detects files-only drift without writing, repairs it and stays byte-idempotent", () => {
    const root = createFixture();
    const original = readOutputs(root);
    expect(runSync(root).status).toBe(0);
    expect(readOutputs(root)).toEqual(original);
    const manifest = readPackage(root);
    const exclusion = "!dist/plugin-sdk/gateway-config-runtime.d.ts";
    manifest.files = manifest.files.filter((file) => file !== exclusion);
    writeJson(root, "package.json", manifest);
    const before = readOutputs(root);

    const result = runSync(root, "--check");

    expect(readOutputs(root)).toEqual(before);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("package.json out of sync");
    expect(result.stderr).toContain("pnpm plugin-sdk:sync-exports");
    expect(result.stdout).not.toContain("synced");
    for (const file of outputFiles.slice(1)) {
      expect(result.stderr).not.toContain(file);
    }
    expect(runSync(root).status).toBe(0);
    expect(readPackage(root)).toEqual({ ...manifest, files: [...manifest.files, exclusion] });
    expect(readOutputs(root).slice(1)).toEqual(before.slice(1));
    const synced = readOutputs(root);
    expect(runSync(root).status).toBe(0);
    expect(runSync(root, "--check").status).toBe(0);
    expect(readOutputs(root)).toEqual(synced);
  });

  it.each(declarationConfigs)("checks $file independently without writing", ({ file }) => {
    const root = createFixture();
    const config = readConfig(root, file);
    delete config.compilerOptions.paths["openclaw/plugin-sdk/browser-cdp"];
    writeJson(root, file, config);
    const before = readOutputs(root);

    const result = runSync(root, "--check");

    expect(readOutputs(root)).toEqual(before);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(file);
    expect(result.stderr).toContain("pnpm plugin-sdk:sync-exports");
    expect(result.stdout).not.toContain("synced");
    for (const other of outputFiles.filter((output) => output !== file)) {
      expect(result.stderr).not.toContain(other);
    }
  });

  it("repairs both declaration maps while preserving all existing custom mappings and fields", () => {
    const root = createFixture();
    const original = readOutputs(root);
    const shared = readConfig(root, declarationConfigs[0].file);
    delete shared.compilerOptions.paths["openclaw/plugin-sdk/browser-cdp"];
    writeJson(root, declarationConfigs[0].file, shared);
    const xai = readConfig(root, declarationConfigs[1].file);
    xai.compilerOptions.paths["openclaw/plugin-sdk/browser-cdp"] = ["./wrong.d.ts"];
    for (const entry of ["channel-secret-owner-runtime", "channel-secret-tts-runtime"]) {
      xai.compilerOptions.paths[`openclaw/plugin-sdk/${entry}`] = ["./wrong.d.ts"];
    }
    writeJson(root, declarationConfigs[1].file, xai);

    const result = runSync(root);

    expect(result.status, result.stderr).toBe(0);
    expect(readOutputs(root).map((text) => JSON.parse(text))).toEqual(
      original.map((text) => JSON.parse(text)),
    );
    const sharedKeys = Object.keys(
      readConfig(root, declarationConfigs[0].file).compilerOptions.paths,
    );
    expect(sharedKeys).toEqual([
      ...Object.keys(shared.compilerOptions.paths),
      "openclaw/plugin-sdk/browser-cdp",
    ]);
    const synced = readOutputs(root);
    expect(runSync(root, "--check").status).toBe(0);
    expect(runSync(root).status).toBe(0);
    expect(readOutputs(root)).toEqual(synced);
  });

  it.each(literalEntries)("packs %s without private types or test-only exports", (entry) => {
    const root = createFixture({
      entries: ["public-entry", entry, "test-fixtures"],
      privateEntries: [entry, "test-fixtures", "qa-lab"],
    });
    const included = [
      "assets/public.txt",
      "dist/plugin-sdk/nested/public.d.ts",
      "dist/plugin-sdk/owner-extra.d.ts",
      "dist/plugin-sdk/public-entry.js",
      "dist/plugin-sdk/public-entry.d.ts",
      `dist/plugin-sdk/${entry}.js`,
    ];
    const excluded = [
      "assets/internal.txt",
      "dist/plugin-sdk/nested/internal.d.ts",
      "dist/plugin-sdk/owner-extra.js",
      "dist/plugin-sdk/public-entry.js.map",
      "dist/plugin-sdk/.tsbuildinfo",
      "dist/plugin-sdk/qa-lab.js",
      "dist/plugin-sdk/owner_entry.json",
      `dist/plugin-sdk/${entry}.d.ts`,
      "dist/plugin-sdk/test-fixtures.js",
      "dist/plugin-sdk/test-fixtures.d.ts",
    ];
    for (const file of [...included, ...excluded]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "fixture\n");
    }
    const result = runSync(root);

    expect(result.status, result.stderr).toBe(0);
    const npm = resolveNpmRunner({ npmArgs: ["pack", "--dry-run", "--json", "--ignore-scripts"] });
    const packed = spawnSync(npm.command, npm.args, { ...npm, cwd: root, encoding: "utf8" });
    expect(packed.status, packed.stderr).toBe(0);
    const packs = resolveNpmJsonEntries(JSON.parse(packed.stdout)) as {
      files: { path: string }[];
    }[];
    expect(packs).toHaveLength(1);
    expect(packs.flatMap((pack) => pack.files.map((file) => file.path)).toSorted()).toEqual(
      ["package.json", ...included].toSorted(),
    );
    expect(readPackage(root).files).toEqual([
      ...fixtureFiles,
      `!dist/plugin-sdk/${entry}.d.ts`,
      "!dist/plugin-sdk/test-fixtures.d.ts",
      "!dist/plugin-sdk/test-fixtures.js",
    ]);
    expect(readPackage(root).exports).toEqual({
      ".": "./index.js",
      "./plugin-sdk/public-entry": {
        types: "./dist/plugin-sdk/public-entry.d.ts",
        default: "./dist/plugin-sdk/public-entry.js",
      },
      [`./plugin-sdk/${entry}`]: { default: `./dist/plugin-sdk/${entry}.js` },
    });
    for (const { file, prefix } of declarationConfigs) {
      expect(readConfig(root, file).compilerOptions.paths).toEqual({
        "openclaw/plugin-sdk/*": [`${prefix}dist/plugin-sdk/*.d.ts`],
        "openclaw/plugin-sdk/custom": [
          `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/custom.d.ts`,
          "./override.d.ts",
        ],
        [`openclaw/plugin-sdk/${entry}`]: [
          `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`,
        ],
        "openclaw/plugin-sdk/test-fixtures": [
          `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/test-fixtures.d.ts`,
        ],
      });
    }
    expectStableSync(root);
  });

  it.each(
    literalEntries.flatMap((entry) => ["removed", "public"].map((kind) => ({ entry, kind }))),
  )(
    "prunes generated aliases and exclusions when $entry becomes $kind, then re-registers it",
    ({ entry, kind }) => {
      const formerEntry = `former-${entry}`;
      const root = createFixture({
        entries: ["private-entry", "test-fixtures", formerEntry],
        privateEntries: ["private-entry", "test-fixtures", formerEntry],
      });
      expect(runSync(root).status).toBe(0);
      writeJson(root, entryList, [
        "private-entry",
        "test-fixtures",
        ...(kind === "public" ? [formerEntry] : []),
      ]);
      writeJson(root, privateList, ["private-entry", "test-fixtures"]);
      const manifest = readPackage(root);
      const retained = [
        "!dist/plugin-sdk/test-fixtures.js",
        ...fixtureFiles,
        "!dist/plugin-sdk/private-entry.d.ts",
        "!dist/plugin-sdk/test-fixtures.d.ts",
      ];
      manifest.files = [
        ...retained,
        "!dist/plugin-sdk/private-entry.js",
        "!dist/plugin-sdk/private-entry.d.ts",
        `!dist/plugin-sdk/${formerEntry}.js`,
        `!dist/plugin-sdk/${formerEntry}.d.ts`,
      ];
      writeJson(root, "package.json", manifest);

      const result = runSync(root);

      expect(result.status, result.stderr).toBe(0);
      expect(readPackage(root).files).toEqual(retained);
      for (const { file, prefix } of declarationConfigs) {
        expect(readConfig(root, file).compilerOptions.paths).toEqual({
          "openclaw/plugin-sdk/*": [`${prefix}dist/plugin-sdk/*.d.ts`],
          "openclaw/plugin-sdk/custom": [
            `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/custom.d.ts`,
            "./override.d.ts",
          ],
          "openclaw/plugin-sdk/private-entry": [
            `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/private-entry.d.ts`,
          ],
          "openclaw/plugin-sdk/test-fixtures": [
            `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/test-fixtures.d.ts`,
          ],
        });
      }
      const exports = readPackage(root).exports;
      expect(exports[`./plugin-sdk/${formerEntry}`]).toEqual(
        kind === "public"
          ? {
              types: `./dist/plugin-sdk/${formerEntry}.d.ts`,
              default: `./dist/plugin-sdk/${formerEntry}.js`,
            }
          : undefined,
      );
      expectStableSync(root);
      writeJson(root, entryList, ["private-entry", "test-fixtures", formerEntry]);
      writeJson(root, privateList, ["private-entry", "test-fixtures", formerEntry]);
      expect(runSync(root).status).toBe(0);
      expect(readPackage(root).files).toEqual([
        ...retained,
        `!dist/plugin-sdk/${formerEntry}.d.ts`,
      ]);
      for (const { file, prefix } of declarationConfigs) {
        expect(
          readConfig(root, file).compilerOptions.paths[`openclaw/plugin-sdk/${formerEntry}`],
        ).toEqual([`${prefix}packages/plugin-sdk/dist/src/plugin-sdk/${formerEntry}.d.ts`]);
      }
      expect(readPackage(root).exports[`./plugin-sdk/${formerEntry}`]).toEqual({
        default: `./dist/plugin-sdk/${formerEntry}.js`,
      });
      expectStableSync(root);
    },
  );

  it.each([{ args: [] }, { args: ["--check"] }])(
    "rejects stale facade files before any writes ($args)",
    ({ args }) => {
      const root = createFixture({ entries: ["private-entry"], privateEntries: ["private-entry"] });
      fs.writeFileSync(path.join(root, "packages/plugin-sdk/src/stale.ts"), "");
      const before = readOutputs(root);

      const result = runSync(root, ...args);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "packages/plugin-sdk/src/stale.ts does not match any plugin SDK entrypoint",
      );
      expect(readOutputs(root)).toEqual(before);
    },
  );
});
