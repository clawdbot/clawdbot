// Check Openclaw Package Tarball tests cover check openclaw package tarball script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-dist-inventory.ts";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mjs";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mjs";
const NODE_DEFAULT_SPAWN_MAX_BUFFER_BYTES = 1024 * 1024;
const FLAT_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/provider-entry.d.ts";
const DEEP_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts";
const AI_RUNTIME_PACKAGE_JSON = JSON.stringify({
  name: "@openclaw/ai",
  version: "2026.6.11",
  exports: {
    ".": { import: "./dist/index.mjs" },
    "./providers": { import: "./dist/providers.mjs" },
    "./transports": { import: "./dist/transports.mjs" },
    "./internal/*": { import: "./dist/internal/*.mjs" },
  },
});
const LEGACY_AI_RUNTIME_PACKAGE_JSON = JSON.stringify({
  name: "@openclaw/ai",
  version: "2026.7.2-beta.4",
  exports: {
    ".": { import: "./dist/index.mjs" },
    "./providers": { import: "./dist/providers.mjs" },
    "./internal/*": { import: "./dist/internal/*.mjs" },
  },
});

function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string) => void,
  version = "0.0.0",
  options: {
    includeControlUi?: boolean;
    includeInstallGuard?: boolean;
    includeShrinkwrap?: boolean;
    includeWorkspaceTemplates?: boolean;
    packageJson?: Record<string, unknown>;
    shrinkwrapRootPackage?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-test-"));
  try {
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version, ...options.packageJson }),
    );
    if (options.includeShrinkwrap !== false) {
      writeFileSync(
        join(packageRoot, "npm-shrinkwrap.json"),
        JSON.stringify({
          name: "openclaw",
          version,
          lockfileVersion: 3,
          packages: {
            "": {
              name: "openclaw",
              version,
              ...options.shrinkwrapRootPackage,
            },
          },
        }),
      );
    }
    writeFileSync(
      join(packageRoot, "dist", "postinstall-inventory.json"),
      JSON.stringify(inventory),
    );
    const workspaceTemplates =
      options.includeWorkspaceTemplates === false
        ? {}
        : Object.fromEntries(
            WORKSPACE_TEMPLATE_PACK_PATHS.map((relativePath) => [
              relativePath,
              `# ${relativePath}\n`,
            ]),
          );
    const controlUiFiles =
      options.includeControlUi === false
        ? {}
        : {
            "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
            "dist/control-ui/assets/app.js": "console.log('ok');\n",
          };
    const installGuardFile =
      options.includeInstallGuard === false
        ? {}
        : {
            [PACKAGE_INSTALL_GUARD_RELATIVE_PATH]:
              "OpenClaw package preinstall has not completed.\n",
          };
    const tarFiles = { ...workspaceTemplates, ...controlUiFiles, ...installGuardFile, ...files };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }

    const tarball = join(root, "openclaw.tgz");
    const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], {
      encoding: "utf8",
    });
    expect(pack.status, pack.stderr).toBe(0);
    testBody(tarball);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-openclaw-package-tarball", () => {
  it("prints help before touching tarball state", () => {
    const result = spawnSync("node", [CHECK_SCRIPT, "--help"], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node scripts/check-openclaw-package-tarball.mjs [--require-bundled-workspace-deps] <openclaw.tgz>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects option-like and extra arguments before tar inspection", () => {
    const unknown = spawnSync("node", [CHECK_SCRIPT, "--tag"], { encoding: "utf8" });

    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown OpenClaw package tarball check option: --tag");
    expect(unknown.stderr).not.toContain("OpenClaw package tarball does not exist");

    const extra = spawnSync("node", [CHECK_SCRIPT, "openclaw.tgz", "extra"], {
      encoding: "utf8",
    });

    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toContain("Unexpected OpenClaw package tarball check argument: extra");
    expect(extra.stderr).not.toContain("OpenClaw package tarball does not exist");
  });

  it("accepts tarballs whose entry list exceeds Node's default spawn buffer", () => {
    const longNameSuffix = "x".repeat(80);
    const largeEntryList = Object.fromEntries(
      Array.from({ length: 8_000 }, (_, index) => [
        `dist/control-ui/assets/large-entry-list/asset-${String(index).padStart(5, "0")}-${longNameSuffix}.txt`,
        "",
      ]),
    );

    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n", ...largeEntryList },
      (tarball) => {
        const listing = spawnSync("tar", ["-tf", tarball], {
          encoding: "utf8",
          maxBuffer: NODE_DEFAULT_SPAWN_MAX_BUFFER_BYTES * 2,
        });
        expect(listing.status, listing.stderr).toBe(0);
        expect(Buffer.byteLength(listing.stdout)).toBeGreaterThan(
          NODE_DEFAULT_SPAWN_MAX_BUFFER_BYTES,
        );

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "removes the extract dir when tar extraction fails",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-extract-fail-"));
      try {
        const fakeBin = join(root, "bin");
        mkdirSync(fakeBin);
        const extractDirFile = join(root, "extract-dir.txt");
        const fakeTar = join(fakeBin, "tar");
        writeFileSync(
          fakeTar,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const args = process.argv.slice(2);",
            "if (args[0] === '-tf') { console.log('package/package.json'); process.exit(0); }",
            "const outputDir = args[args.indexOf('-C') + 1];",
            "fs.writeFileSync(process.env.OPENCLAW_TEST_EXTRACT_DIR_FILE, outputDir);",
            "console.error('extract denied');",
            "process.exit(7);",
          ].join("\n"),
        );
        chmodSync(fakeTar, 0o755);
        const tarball = join(root, "openclaw.tgz");
        writeFileSync(tarball, "not used by fake tar");

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_TEST_EXTRACT_DIR_FILE: extractDirFile,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("extract denied");
        expect(existsSync(readFileSync(extractDirFile, "utf8"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("allows legacy private QA inventory entries omitted from shipped tarballs through 2026.4.25", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy inventory references omitted private QA");
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.25-beta.10",
    );
  });

  it("rejects legacy private QA inventory omissions for newer packages", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory references missing tar entry dist/extensions/qa-channel/runtime-api.js",
        );
        expect(result.stderr).not.toContain("legacy inventory references omitted private QA");
      },
      "2026.4.26",
    );
  });

  it("still rejects non-legacy missing inventory entries", () => {
    withTarball(
      ["dist/index.js", "dist/cli.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory references missing tar entry dist/cli.js");
      },
    );
  });

  it("requires an install guard omitted from the dist inventory", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `missing required tar entry ${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
        );
      },
      "0.0.0",
      { includeInstallGuard: false },
    );

    withTarball(
      ["dist/index.js", PACKAGE_INSTALL_GUARD_RELATIVE_PATH],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `package dist inventory must omit install guard ${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
        );
      },
    );

    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy package omits the preinstall completion guard");
      },
      "2026.7.1",
      { includeInstallGuard: false },
    );
  });

  it("rejects stale deep plugin SDK declaration inventory entries", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION, DEEP_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `inventory references missing tar entry ${DEEP_PLUGIN_SDK_DECLARATION}`,
        );
      },
    );
  });

  it("accepts flat plugin SDK declaration inventory without the old deep tree", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
    );
  });

  it("rejects dist files that import missing relative chunks", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      { "dist/cli/run-main.js": 'await import("../memory-state-old.js");\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "dist/cli/run-main.js imports missing dist/memory-state-old.js",
        );
      },
      "2026.4.27",
    );
  });

  it("accepts dist files whose relative chunks are present", () => {
    withTarball(
      ["dist/cli/run-main.js", "dist/memory-state-current.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects imported dist chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory omits imported dist file dist/memory-state-current.js",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects CommonJS require chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/index.cjs"],
      {
        "dist/index.cjs": 'module.exports = require("./chunk.cjs");\n',
        "dist/chunk.cjs": "module.exports = {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits imported dist file dist/chunk.cjs");
      },
      "2026.4.27",
    );
  });

  it("rejects dist files with missing import.meta.url URL dependencies", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dist/index.js imports missing dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("rejects formatted import.meta.url URL dependencies", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": [
          "const worker = new URL(",
          '  "./worker.js",',
          "  import.meta.url,",
          ");",
          "",
        ].join("\n"),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dist/index.js imports missing dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("rejects import.meta.url URL dependencies omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n',
        "dist/worker.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits imported dist file dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("allows import.meta.url package-root probes", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": 'const root = new URL("../..", import.meta.url);\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("allows import.meta.url source helper probes", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js":
          'const shim = new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url);\n',
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects missing Control UI assets", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry dist/control-ui/index.html");
        expect(result.stderr).toContain(
          "missing required tar entries under dist/control-ui/assets/",
        );
      },
      "2026.4.27",
      { includeControlUi: false },
    );
  });

  it("rejects package tarballs without workspace templates", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        for (const relativePath of WORKSPACE_TEMPLATE_PACK_PATHS) {
          expect(result.stderr).toContain(`missing required tar entry ${relativePath}`);
        }
      },
      "2026.6.11",
      { includeWorkspaceTemplates: false },
    );
  });

  it("allows legacy package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy package omits npm-shrinkwrap.json");
      },
      "2026.5.20",
      { includeShrinkwrap: false },
    );
  });

  it("rejects new package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry npm-shrinkwrap.json");
      },
      "2026.5.21",
      { includeShrinkwrap: false },
    );
  });

  it("rejects package-lock.json in package tarballs", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n", "package-lock.json": "{}\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package tarball must ship npm-shrinkwrap.json, not package-lock.json",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects workspace protocol dependencies in package manifests", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package.json dependencies.@openclaw/ai must not use workspace protocol workspace:*",
        );
      },
      "2026.6.11",
      { packageJson: { dependencies: { "@openclaw/ai": "workspace:*" } } },
    );
  });

  it("rejects workspace protocol dependencies in shrinkwrap root metadata", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "npm-shrinkwrap.json packages root dependencies.@openclaw/ai must not use workspace protocol workspace:*",
        );
      },
      "2026.6.11",
      { shrinkwrapRootPackage: { dependencies: { "@openclaw/ai": "workspace:*" } } },
    );
  });

  it("accepts separately published private workspace dependencies by default", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.6.11",
      { packageJson: { dependencies: { "@openclaw/ai": "2026.6.11" } } },
    );
  });

  it("rejects private workspace dependencies that are not bundled when strict packaging requires it", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package.json dependencies.@openclaw/ai must be listed in bundleDependencies because it is private to the OpenClaw workspace",
        );
        expect(result.stderr).toContain(
          "package.json dependencies.@openclaw/ai must be bundled in node_modules/@openclaw/ai",
        );
      },
      "2026.6.11",
      { packageJson: { dependencies: { "@openclaw/ai": "2026.6.11" } } },
    );
  });

  it("rejects private workspace dependencies when only metadata is bundled", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/index.mjs",
        );
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/providers.mjs",
        );
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/internal/runtime.mjs",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("accepts private workspace dependencies when their runtime is bundled", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/transports.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("accepts frozen AI runtimes that predate an optional exported subpath", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": LEGACY_AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.7.2-beta.4",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.7.2-beta.4" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects a missing required bundled AI runtime entry", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/transports.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/providers.mjs",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects bundled AI entries that its manifest does not export", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": JSON.stringify({
          name: "@openclaw/ai",
          version: "2026.6.11",
          exports: {
            ".": "./dist/index.mjs",
            "./providers": null,
            "./internal/*": "./dist/internal/*.mjs",
          },
        }),
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/transports.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai runtime specifier @openclaw/ai/providers is not resolvable",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects missing relative imports from bundled AI runtime entries", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": 'export * from "./missing.mjs";\n',
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai dist/internal/runtime.mjs imports missing dist/internal/missing.mjs",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects local build metadata entries in package tarballs", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.runtime-postbuildstamp",
        );
      },
      "2026.4.27",
    );
  });

  it("allows local build metadata in already published legacy packages through 2026.4.26", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.runtime-postbuildstamp",
        );
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.26",
    );
  });
});
