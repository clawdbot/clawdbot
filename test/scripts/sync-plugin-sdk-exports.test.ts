import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function readPackageExports(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).exports;
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
    writeJson(root, "package.json", { type: "module", exports: { ".": "./index.js" } });
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

describe("plugin SDK registration CLI", () => {
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

  it("registers private workspace types without publishing them or test-only exports", () => {
    const root = createFixture({
      entries: ["public-entry", "private-entry", "test-fixtures"],
      privateEntries: ["private-entry", "test-fixtures", "qa-lab"],
    });
    const result = runSync(root);

    expect(result.status, result.stderr).toBe(0);
    expect(readPackageExports(root)).toEqual({
      ".": "./index.js",
      "./plugin-sdk/public-entry": {
        types: "./dist/plugin-sdk/public-entry.d.ts",
        default: "./dist/plugin-sdk/public-entry.js",
      },
      "./plugin-sdk/private-entry": { default: "./dist/plugin-sdk/private-entry.js" },
    });
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
  });

  it.each(["removed", "public"])(
    "prunes generated aliases when a private entry becomes %s",
    (kind) => {
      const root = createFixture({
        entries: kind === "public" ? ["former-private"] : [],
        privateEntries: [],
      });
      for (const { file, prefix } of declarationConfigs) {
        const config = readConfig(root, file);
        config.compilerOptions.paths["openclaw/plugin-sdk/former-private"] = [
          `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/former-private.d.ts`,
        ];
        writeJson(root, file, config);
      }

      const result = runSync(root);

      expect(result.status, result.stderr).toBe(0);
      for (const { file, prefix } of declarationConfigs) {
        expect(readConfig(root, file).compilerOptions.paths).toEqual({
          "openclaw/plugin-sdk/*": [`${prefix}dist/plugin-sdk/*.d.ts`],
          "openclaw/plugin-sdk/custom": [
            `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/custom.d.ts`,
            "./override.d.ts",
          ],
        });
      }
      const exports = readPackageExports(root);
      expect(exports["./plugin-sdk/former-private"]).toEqual(
        kind === "public"
          ? {
              types: "./dist/plugin-sdk/former-private.d.ts",
              default: "./dist/plugin-sdk/former-private.js",
            }
          : undefined,
      );
      writeJson(root, entryList, ["former-private"]);
      writeJson(root, privateList, ["former-private"]);
      expect(runSync(root).status).toBe(0);
      for (const { file, prefix } of declarationConfigs) {
        expect(
          readConfig(root, file).compilerOptions.paths["openclaw/plugin-sdk/former-private"],
        ).toEqual([`${prefix}packages/plugin-sdk/dist/src/plugin-sdk/former-private.d.ts`]);
      }
      expect(readPackageExports(root)["./plugin-sdk/former-private"]).toEqual({
        default: "./dist/plugin-sdk/former-private.js",
      });
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
