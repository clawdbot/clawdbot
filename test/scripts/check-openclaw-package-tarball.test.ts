// Check Openclaw Package Tarball tests cover check openclaw package tarball script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { gte as semverGte, valid as validSemver } from "semver";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mts";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-dist-inventory.ts";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mts";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mts";
const PUBLIC_CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mjs";
const NODE_DEFAULT_SPAWN_MAX_BUFFER_BYTES = 1024 * 1024;
const CODE_MODE_WORKER_PATH = "dist/agents/code-mode.worker.js";
const FIRST_CODE_MODE_WORKER_VERSION = "2026.5.14-beta.2";
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
    "./internal/runtime": { import: "./dist/internal/runtime.mjs" },
  },
});

function usesLegacyShrinkwrapByDefault(version: string): boolean {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/u.exec(version);
  if (!match) {
    return false;
  }
  const [year = 0, month = 0, patch = 0] = match.slice(1).map(Number);
  return year < 2026 || (year === 2026 && (month < 7 || (month === 7 && patch < 2)));
}

function chmodTreeWorldReadable(dir: string) {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodTreeWorldReadable(entryPath);
    } else {
      chmodSync(entryPath, 0o644);
    }
  }
}

function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string) => void,
  version = "2026.7.2",
  options: {
    includeCodeModeWorker?: boolean;
    includeCodeModeWorkerInInventory?: boolean;
    includeControlUi?: boolean;
    includeInstallGuard?: boolean;
    includeShrinkwrap?: boolean;
    includeWorkspaceTemplates?: boolean;
    packageJson?: Record<string, unknown>;
    postinstall?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-test-"));
  try {
    const validVersion = validSemver(version);
    const includeCodeModeWorker =
      options.includeCodeModeWorker ??
      (validVersion !== null && semverGte(validVersion, FIRST_CODE_MODE_WORKER_VERSION));
    const includeCodeModeWorkerInInventory =
      options.includeCodeModeWorkerInInventory ?? includeCodeModeWorker;
    const controlUiFiles =
      options.includeControlUi === false
        ? {}
        : {
            "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
            "dist/control-ui/assets/app.js": "console.log('ok');\n",
          };
    const packageInventory = [
      ...new Set([
        ...inventory,
        ...(options.postinstall ? Object.keys(controlUiFiles) : []),
        ...(includeCodeModeWorkerInInventory ? [CODE_MODE_WORKER_PATH] : []),
      ]),
    ];
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        ...(options.postinstall
          ? { scripts: { postinstall: "node scripts/postinstall-bundled-plugins.mjs" } }
          : {}),
        ...options.packageJson,
      }),
    );
    writeFileSync(
      join(packageRoot, "dist", "postinstall-inventory.json"),
      JSON.stringify(packageInventory),
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
    const installGuardFile =
      options.includeInstallGuard === false
        ? {}
        : {
            [PACKAGE_INSTALL_GUARD_RELATIVE_PATH]:
              "OpenClaw package preinstall has not completed.\n",
          };
    const shrinkwrapFile =
      (options.includeShrinkwrap ?? usesLegacyShrinkwrapByDefault(version))
        ? {
            "npm-shrinkwrap.json": `${JSON.stringify({
              name: "openclaw",
              version,
              lockfileVersion: 3,
              packages: { "": { name: "openclaw", version } },
            })}\n`,
          }
        : {};
    const tarFiles = {
      ...workspaceTemplates,
      ...controlUiFiles,
      ...installGuardFile,
      ...shrinkwrapFile,
      ...(includeCodeModeWorker ? { [CODE_MODE_WORKER_PATH]: "export {};\n" } : {}),
      ...files,
    };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }
    // The tarball mode gate requires world-readable entries; pin the fixture
    // against restrictive host umasks the way the packer normalizes artifacts.
    chmodTreeWorldReadable(packageRoot);

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

type TarballCheck = {
  inventory?: Parameters<typeof withTarball>[0];
  files?: Parameters<typeof withTarball>[1];
  version?: Parameters<typeof withTarball>[3];
  options?: Parameters<typeof withTarball>[4];
  strict?: boolean;
  status: 0 | "nonzero";
  stderr?: string[];
  notStderr?: string[];
  successText?: boolean;
};

type NamedTarballCheck = TarballCheck & { name: string };

function checkTarball({
  inventory = ["dist/index.js"],
  files = { "dist/index.js": "export {};\n" },
  version,
  options,
  strict = false,
  status,
  stderr = [],
  notStderr = [],
  successText = false,
}: TarballCheck) {
  withTarball(
    inventory,
    files,
    (tarball) => {
      const args = strict
        ? [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball]
        : [CHECK_SCRIPT, tarball];
      const result = spawnSync("node", args, { encoding: "utf8" });

      if (status === 0) {
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(result.status).not.toBe(0);
      }
      for (const text of stderr) {
        expect(result.stderr).toContain(text);
      }
      for (const text of notStderr) {
        expect(result.stderr).not.toContain(text);
      }
      if (successText) {
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      }
    },
    version,
    options,
  );
}

describe("check-openclaw-package-tarball", () => {
  it("prints help before touching tarball state", () => {
    const result = spawnSync("node", [PUBLIC_CHECK_SCRIPT, "--help"], { encoding: "utf8" });

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

  it.skipIf(process.platform === "win32")("rejects owner-only tar entry modes", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-modes-"));
    try {
      const packageRoot = join(root, "package");
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.8.26" }),
      );
      writeFileSync(join(packageRoot, "dist", "index.js"), "export {};\n");
      chmodTreeWorldReadable(packageRoot);
      chmodSync(join(packageRoot, "dist", "index.js"), 0o600);
      const tarball = join(root, "openclaw.tgz");
      const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], {
        encoding: "utf8",
      });
      expect(pack.status, pack.stderr).toBe(0);

      const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "tar entry is not world-readable (-rw-------): package/dist/index.js",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
            "if (args[0] === '-tvf') { console.log('-rw-r--r-- 0/0 0 2026-08-29 package/package.json'); process.exit(0); }",
            "if (args[0] !== '-xf') { throw new Error('unexpected tar operation'); }",
            "const outputDir = args[args.indexOf('-C') + 1];",
            "if (!fs.statSync(outputDir).isDirectory()) { throw new Error('missing extract dir'); }",
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
        expect(result.stderr).toContain("tar -xf failed");
        const extractDir = readFileSync(extractDirFile, "utf8");
        expect(isAbsolute(extractDir)).toBe(true);
        expect(existsSync(extractDir)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  const legacyInventoryCases: NamedTarballCheck[] = [
    {
      name: "allows legacy private QA inventory entries omitted from shipped tarballs through 2026.4.25",
      inventory: ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      version: "2026.4.25-beta.10",
      status: 0,
      successText: true,
      stderr: ["legacy inventory references omitted private QA"],
    },
    {
      name: "rejects legacy private QA inventory omissions for newer packages",
      inventory: ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      version: "2026.4.26",
      status: "nonzero",
      stderr: ["inventory references missing tar entry dist/extensions/qa-channel/runtime-api.js"],
      notStderr: ["legacy inventory references omitted private QA"],
    },
  ];
  for (const testCase of legacyInventoryCases) {
    it(testCase.name, () => checkTarball(testCase));
  }

  it("requires an install guard omitted from the dist inventory", () => {
    checkTarball({
      version: "0.0.0",
      options: { includeInstallGuard: false },
      status: "nonzero",
      stderr: [`missing required tar entry ${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`],
    });

    checkTarball({
      inventory: ["dist/index.js", PACKAGE_INSTALL_GUARD_RELATIVE_PATH],
      status: "nonzero",
      stderr: [
        `package dist inventory must omit install guard ${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
      ],
    });

    checkTarball({
      version: "2026.7.1",
      options: { includeInstallGuard: false },
      status: 0,
      stderr: ["legacy package omits the preinstall completion guard"],
    });
  });

  it("rejects stale deep plugin SDK declaration inventory entries", () => {
    checkTarball({
      inventory: [FLAT_PLUGIN_SDK_DECLARATION, DEEP_PLUGIN_SDK_DECLARATION],
      files: { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      status: "nonzero",
      stderr: [`inventory references missing tar entry ${DEEP_PLUGIN_SDK_DECLARATION}`],
    });
  });

  it.each([
    ["bundled plugin manifest", "dist/extensions/example/openclaw.plugin.json", "{}\n"],
    ["generated non-JavaScript sidecar", "dist/generated/example.schema.json", "{}\n"],
  ])(
    "rejects a packaged %s omitted from the postinstall inventory",
    (_, relativePath, contents) => {
      checkTarball({
        files: { "dist/index.js": "export {};\n", [relativePath]: contents },
        version: "2026.7.2",
        options: { postinstall: true },
        status: "nonzero",
        stderr: [`postinstall inventory omits packaged dist file ${relativePath}`],
      });
    },
  );

  const packageContractCases: NamedTarballCheck[] = [
    {
      name: "accepts historical packages published before the Code Mode worker existed",
      version: "2026.5.14-beta.1",
      status: 0,
      successText: true,
    },
    {
      name: "rejects Code Mode packages that omit the dynamically loaded worker",
      version: FIRST_CODE_MODE_WORKER_VERSION,
      options: { includeCodeModeWorker: false },
      status: "nonzero",
      stderr: [`missing required tar entry ${CODE_MODE_WORKER_PATH}`],
    },
    {
      name: "rejects Code Mode workers that postinstall would remove",
      version: FIRST_CODE_MODE_WORKER_VERSION,
      options: { includeCodeModeWorkerInInventory: false, postinstall: true },
      status: "nonzero",
      stderr: [`postinstall inventory omits packaged dist file ${CODE_MODE_WORKER_PATH}`],
    },
    {
      name: "rejects dist files that import missing relative chunks",
      inventory: ["dist/cli/run-main.js"],
      files: { "dist/cli/run-main.js": 'await import("../memory-state-old.js");\n' },
      version: "2026.4.27",
      status: "nonzero",
      stderr: ["dist/cli/run-main.js imports missing dist/memory-state-old.js"],
    },
    {
      name: "rejects leaked private QA Docker chunks that import an omitted QA runtime",
      inventory: ["dist/docker-runtime-BVdgRgxA.js"],
      files: {
        "dist/docker-runtime-BVdgRgxA.js":
          'import { createQaDockerRuntime } from "./qa-runtime-Bi1S3plf.js";\n' +
          "export { createQaDockerRuntime };\n",
      },
      status: "nonzero",
      stderr: ["dist/docker-runtime-BVdgRgxA.js imports missing dist/qa-runtime-Bi1S3plf.js"],
    },
    {
      name: "accepts dist files whose relative chunks are present",
      inventory: ["dist/cli/run-main.js", "dist/memory-state-current.js"],
      files: {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      version: "2026.4.27",
      status: 0,
      successText: true,
    },
    {
      name: "rejects imported dist chunks omitted from the postinstall inventory",
      inventory: ["dist/cli/run-main.js"],
      files: {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      version: "2026.4.27",
      options: { postinstall: true },
      status: "nonzero",
      stderr: ["postinstall inventory omits packaged dist file dist/memory-state-current.js"],
    },
    {
      name: "rejects named imported chunks omitted from the postinstall inventory",
      files: {
        "dist/index.js": 'import { value } from "./chunk.js";\nexport { value };\n',
        "dist/chunk.js": "export const value = 42;\n",
      },
      version: "2026.4.27",
      options: { postinstall: true },
      status: "nonzero",
      stderr: ["postinstall inventory omits packaged dist file dist/chunk.js"],
    },
    {
      name: "rejects CommonJS require chunks omitted from the postinstall inventory",
      inventory: ["dist/index.cjs"],
      files: {
        "dist/index.cjs": 'module.exports = require("./chunk.cjs");\n',
        "dist/chunk.cjs": "module.exports = {};\n",
      },
      version: "2026.4.27",
      options: { postinstall: true },
      status: "nonzero",
      stderr: ["postinstall inventory omits packaged dist file dist/chunk.cjs"],
    },
    {
      name: "rejects dist files with missing import.meta.url URL dependencies",
      files: { "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n' },
      version: "2026.4.27",
      status: "nonzero",
      stderr: ["dist/index.js imports missing dist/worker.js"],
    },
    {
      name: "rejects formatted import.meta.url URL dependencies",
      files: {
        "dist/index.js": [
          "const worker = new URL(",
          '  "./worker.js",',
          "  import.meta.url,",
          ");",
          "",
        ].join("\n"),
      },
      version: "2026.4.27",
      status: "nonzero",
      stderr: ["dist/index.js imports missing dist/worker.js"],
    },
    {
      name: "rejects import.meta.url URL dependencies omitted from the postinstall inventory",
      files: {
        "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n',
        "dist/worker.js": "export {};\n",
      },
      version: "2026.4.27",
      options: { postinstall: true },
      status: "nonzero",
      stderr: ["postinstall inventory omits packaged dist file dist/worker.js"],
    },
    {
      name: "allows import.meta.url package-root probes",
      files: { "dist/index.js": 'const root = new URL("../..", import.meta.url);\n' },
      version: "2026.4.27",
      status: 0,
      successText: true,
    },
    {
      name: "rejects missing Control UI assets",
      version: "2026.4.27",
      options: { includeControlUi: false },
      status: "nonzero",
      stderr: [
        "missing required tar entry dist/control-ui/index.html",
        "missing required tar entries under dist/control-ui/assets/",
      ],
    },
    {
      name: "rejects package tarballs without workspace templates",
      version: "2026.6.11",
      options: { includeWorkspaceTemplates: false },
      status: "nonzero",
      stderr: WORKSPACE_TEMPLATE_PACK_PATHS.map(
        (relativePath) => `missing required tar entry ${relativePath}`,
      ),
    },
    {
      name: "allows package tarballs without npm lockfiles",
      version: "2026.5.20",
      options: { includeShrinkwrap: false },
      status: 0,
      successText: true,
    },
    {
      name: "rejects package-lock.json in package tarballs",
      files: { "dist/index.js": "export {};\n", "package-lock.json": "{}\n" },
      version: "2026.4.27",
      status: "nonzero",
      stderr: ["package tarball must not contain package-lock.json"],
    },
    {
      name: "rejects workspace protocol dependencies in package manifests",
      version: "2026.6.11",
      options: { packageJson: { dependencies: { "@openclaw/ai": "workspace:*" } } },
      status: "nonzero",
      stderr: [
        "package.json dependencies.@openclaw/ai must not use workspace protocol workspace:*",
      ],
    },
    {
      name: "rejects npm-shrinkwrap.json after the 2026.7.2 transition train",
      files: { "dist/index.js": "export {};\n", "npm-shrinkwrap.json": "{}\n" },
      version: "2026.7.3",
      status: "nonzero",
      stderr: ["package tarball must not contain npm-shrinkwrap.json"],
    },
  ];
  for (const testCase of packageContractCases) {
    it(testCase.name, () => checkTarball(testCase));
  }

  it.each(["2026.7.2-beta.4", "2026.7.2"])(
    "tolerates a valid shrinkwrap in the %s transition train",
    (version) => {
      checkTarball({
        files: {
          "dist/index.js": "export {};\n",
          "npm-shrinkwrap.json": `${JSON.stringify({
            name: "openclaw",
            version,
            lockfileVersion: 3,
            packages: { "": { name: "openclaw", version } },
          })}\n`,
        },
        version,
        status: 0,
        stderr: ["2026.7.2 transition package contains npm-shrinkwrap.json"],
      });
    },
  );

  it("accepts a valid shrinkwrap in an already-published package", () => {
    const version = "2026.6.11";
    checkTarball({
      files: {
        "dist/index.js": "export {};\n",
        "npm-shrinkwrap.json": `${JSON.stringify({
          name: "openclaw",
          version,
          lockfileVersion: 3,
          packages: { "": { name: "openclaw", version } },
        })}\n`,
      },
      version,
      status: 0,
    });
  });

  const bundledRuntimeCases: NamedTarballCheck[] = [
    {
      name: "accepts separately published private workspace dependencies by default",
      version: "2026.6.11",
      options: { packageJson: { dependencies: { "@openclaw/ai": "2026.6.11" } } },
      status: 0,
      successText: true,
    },
    {
      name: "rejects private workspace dependencies that are not bundled when strict packaging requires it",
      version: "2026.6.11",
      options: { packageJson: { dependencies: { "@openclaw/ai": "2026.6.11" } } },
      strict: true,
      status: "nonzero",
      stderr: [
        "package.json dependencies.@openclaw/ai must be listed in bundleDependencies because it is private to the OpenClaw workspace",
        "package.json dependencies.@openclaw/ai must be bundled in node_modules/@openclaw/ai",
      ],
    },
    {
      name: "rejects private workspace dependencies when only metadata is bundled",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
      },
      version: "2026.6.11",
      options: {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
      strict: true,
      status: "nonzero",
      stderr: [
        "bundled @openclaw/ai is missing required runtime entry dist/index.mjs",
        "bundled @openclaw/ai is missing required runtime entry dist/providers.mjs",
        "bundled @openclaw/ai is missing required runtime entry dist/internal/runtime.mjs",
      ],
    },
    {
      name: "accepts private workspace dependencies when their runtime is bundled",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/transports.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/openai-responses-payload-policy.mjs":
          "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      version: "2026.6.11",
      options: {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
      strict: true,
      status: 0,
      successText: true,
    },
    {
      name: "accepts frozen AI runtimes that predate an optional exported subpath",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": LEGACY_AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      version: "2026.7.2-beta.4",
      options: {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.7.2-beta.4" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
      strict: true,
      status: 0,
      successText: true,
    },
    {
      name: "rejects a missing required bundled AI runtime entry",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/transports.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/openai-responses-payload-policy.mjs":
          "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      version: "2026.6.11",
      options: {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
      strict: true,
      status: "nonzero",
      stderr: ["bundled @openclaw/ai is missing required runtime entry dist/providers.mjs"],
    },
    {
      name: "rejects bundled AI entries that its manifest does not export",
      files: {
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
        "node_modules/@openclaw/ai/dist/internal/openai-responses-payload-policy.mjs":
          "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      version: "2026.6.11",
      options: {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
      strict: true,
      status: "nonzero",
      stderr: ["bundled @openclaw/ai runtime specifier @openclaw/ai/providers is not resolvable"],
    },
    {
      name: "rejects missing relative imports from bundled AI runtime entries",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/transports.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/openai-responses-payload-policy.mjs":
          "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": 'export * from "./missing.mjs";\n',
      },
      version: "2026.6.11",
      options: {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
      strict: true,
      status: "nonzero",
      stderr: [
        "bundled @openclaw/ai dist/internal/runtime.mjs imports missing dist/internal/missing.mjs",
      ],
    },
    {
      name: "rejects local build metadata entries in package tarballs",
      inventory: ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      files: {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      version: "2026.4.27",
      status: "nonzero",
      stderr: [
        "forbidden local build metadata tar entry dist/.buildstamp",
        "forbidden local build metadata tar entry dist/.runtime-postbuildstamp",
      ],
    },
    {
      name: "allows local build metadata in already published legacy packages through 2026.4.26",
      inventory: ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      files: {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      version: "2026.4.26",
      status: 0,
      successText: true,
      stderr: [
        "legacy package includes local build metadata tar entry dist/.buildstamp",
        "legacy package includes local build metadata tar entry dist/.runtime-postbuildstamp",
      ],
    },
  ];
  for (const testCase of bundledRuntimeCases) {
    it(testCase.name, () => checkTarball(testCase));
  }
});
