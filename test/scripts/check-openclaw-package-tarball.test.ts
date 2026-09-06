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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { gte as semverGte, valid as validSemver } from "semver";
import { Header, type HeaderData, Pax } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mts";
const PUBLIC_CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mjs";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function listFilesRecursively(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(prefix, entry.name);
    return entry.isDirectory()
      ? listFilesRecursively(join(dir, entry.name), relativePath)
      : [relativePath];
  });
}

function writeCraftedTarball(
  tarball: string,
  entries: Array<HeaderData & { body?: Buffer | string; pax?: HeaderData }>,
) {
  const blocks: Buffer[] = [];
  for (const { body = "", pax, ...data } of entries) {
    const contents = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const headerData = {
      gid: 0,
      mode: data.type === "Directory" ? 0o755 : 0o644,
      mtime: new Date(0),
      size: contents.length,
      uid: 0,
      ...data,
    };
    if (pax) {
      blocks.push(new Pax({ ...headerData, ...pax }).encode());
    }
    const header = new Header(headerData);
    const headerBlock = Buffer.alloc(512);
    if (header.encode(headerBlock) && !pax) {
      blocks.push(new Pax(headerData).encode());
    }
    blocks.push(headerBlock, contents);
    const padding = contents.length % 512;
    if (padding !== 0) {
      blocks.push(Buffer.alloc(512 - padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(tarball, gzipSync(Buffer.concat(blocks)));
}

function checkCraftedTarball(
  entries: Array<HeaderData & { body?: Buffer | string; pax?: HeaderData }>,
  expectedErrors: string | string[],
) {
  const root = tempDirs.make("openclaw-package-tarball-crafted-");
  const tarball = join(root, "crafted.tgz");
  writeCraftedTarball(tarball, entries);
  const result = spawnSync(process.execPath, [resolve(CHECK_SCRIPT), tarball], {
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  for (const expectedError of Array.isArray(expectedErrors) ? expectedErrors : [expectedErrors]) {
    expect(result.stderr).toContain(expectedError);
  }
}

function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string, root: string, packageRoot: string) => void,
  version = "2026.7.2",
  options: {
    includeCodeModeWorker?: boolean;
    includeCodeModeWorkerInInventory?: boolean;
    includeControlUi?: boolean;
    emptyDirectories?: string[];
    filesOnlyArchive?: boolean;
    includeLifecycleMarker?: boolean;
    includeShrinkwrap?: boolean;
    includeWorkspaceTemplates?: boolean;
    inventoryBody?: string | null;
    packageJson?: Record<string, unknown>;
    pnpmPack?: boolean;
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
    const declaredFiles = Array.isArray(options.packageJson?.files)
      ? options.packageJson.files
      : [];
    const fixturePackageFiles = Array.isArray(options.packageJson?.files)
      ? [
          ...(options.includeWorkspaceTemplates === false ? [] : ["docs/reference/templates/**"]),
          ...(options.includeLifecycleMarker === false
            ? []
            : [
                PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
                PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
              ]),
          ...declaredFiles,
        ]
      : undefined;
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
        ...(fixturePackageFiles ? { files: fixturePackageFiles } : {}),
      }),
    );
    if (options.inventoryBody !== null) {
      writeFileSync(
        join(packageRoot, "dist", "postinstall-inventory.json"),
        options.inventoryBody ?? JSON.stringify(packageInventory),
      );
    }
    const workspaceTemplates =
      options.includeWorkspaceTemplates === false
        ? {}
        : Object.fromEntries(
            WORKSPACE_TEMPLATE_PACK_PATHS.map((relativePath) => [
              relativePath,
              `# ${relativePath}\n`,
            ]),
          );
    const lifecycleMarkerFile =
      options.includeLifecycleMarker === false
        ? {}
        : {
            [PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH]: "pending\n",
            [PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH]: "export {};\n",
          };
    const shrinkwrapFile =
      (options.includeShrinkwrap ?? declaredFiles.includes("npm-shrinkwrap.json"))
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
      ...lifecycleMarkerFile,
      ...shrinkwrapFile,
      ...(includeCodeModeWorker ? { [CODE_MODE_WORKER_PATH]: "export {};\n" } : {}),
      ...files,
    };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }
    for (const relativePath of options.emptyDirectories ?? []) {
      mkdirSync(join(packageRoot, relativePath), { recursive: true });
    }
    // The tarball mode gate requires world-readable entries; pin the fixture
    // against restrictive host umasks the way the packer normalizes artifacts.
    chmodTreeWorldReadable(packageRoot);

    const tarball = options.pnpmPack
      ? join(root, `openclaw-${version}.tgz`)
      : join(root, process.platform === "win32" ? "openclaw.tgz" : "openclaw:local.tgz");
    const pnpm = options.pnpmPack
      ? resolvePnpmRunner({
          cwd: packageRoot,
          pnpmArgs: ["pack", "--config.ignore-scripts=true", "--pack-destination", root],
        })
      : undefined;
    const pack = pnpm
      ? spawnSync(pnpm.command, pnpm.args, {
          cwd: packageRoot,
          encoding: "utf8",
          env: process.env,
          shell: pnpm.shell,
          timeout: 30_000,
          windowsVerbatimArguments: pnpm.windowsVerbatimArguments,
        })
      : spawnSync(
          "tar",
          [
            "-czf",
            `./${basename(tarball)}`,
            ...(options.filesOnlyArchive
              ? listFilesRecursively(packageRoot).map(
                  (relativePath) => `package/${relativePath.replaceAll("\\", "/")}`,
                )
              : ["package"]),
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, COPYFILE_DISABLE: "1" },
          },
        );
    expect(pack.status, pack.stderr || pack.error?.message).toBe(0);
    testBody(tarball, root, packageRoot);
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

  it("rejects owner-only tar entry modes", () => {
    checkCraftedTarball(
      [
        {
          path: "package/package.json",
          type: "File",
          mode: 0o600,
          body: '{"name":"openclaw","version":"2026.9.4"}\n',
        },
      ],
      "tar entry is not world-readable (0600): package/package.json",
    );
  });

  it("accepts a real pnpm-produced package with the same npm inventory", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync(process.execPath, [resolve(CHECK_SCRIPT), tarball], {
          encoding: "utf8",
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
        expect(result.stderr).toMatch(/npm pack inventory \(npm \d+\.\d+\.\d+/u);
      },
      "2026.9.4",
      { pnpmPack: true },
    );
  });

  it("never executes package lifecycle scripts while collecting npm inventory", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball, root) => {
        const marker = join(root, "lifecycle-script-ran");
        rmSync(marker, { force: true });
        const result = spawnSync(process.execPath, [resolve(CHECK_SCRIPT), tarball], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_TEST_LIFECYCLE_MARKER: marker,
          },
        });

        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(marker)).toBe(false);
      },
      "2026.9.4",
      {
        packageJson: {
          scripts: {
            prepack:
              "node -e \"require('node:fs').writeFileSync(process.env.OPENCLAW_TEST_LIFECYCLE_MARKER, 'ran')\"",
            prepare:
              "node -e \"require('node:fs').writeFileSync(process.env.OPENCLAW_TEST_LIFECYCLE_MARKER, 'ran')\"",
          },
        },
      },
    );
  });

  it("accepts archives without explicit directory entries", () => {
    checkTarball({
      options: { filesOnlyArchive: true },
      status: 0,
      successText: true,
    });
  });

  it("rejects an archive package.json symlink before changing its external target", () => {
    const root = tempDirs.make("openclaw-package-tarball-link-");
    const externalRoot = tempDirs.make("openclaw-package-link-target-");
    const externalManifestPath = join(externalRoot, "package.json");
    const capturePath = join(root, "npm-pack-capture.json");
    const originalBytes = Buffer.from(
      '{"name":"openclaw","version":"2026.9.4","scripts":{"prepack":"exit 99"}}\n',
    );
    writeFileSync(externalManifestPath, originalBytes);
    chmodSync(externalManifestPath, 0o444);
    const originalMode = statSync(externalManifestPath).mode;
    const tarball = join(root, "linked-package-json.tgz");
    writeCraftedTarball(tarball, [
      {
        path: "package/package.json",
        type: "SymbolicLink",
        linkpath: externalManifestPath,
      },
    ]);
    const preload = join(root, "capture-npm-pack.mjs");
    writeFileSync(
      preload,
      `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function patchedSpawnSync(...callArgs) {
  const args = callArgs[1];
  if (Array.isArray(args) && args.includes("pack") && args.includes("--dry-run")) {
    fs.writeFileSync(process.env.OPENCLAW_TEST_NPM_CAPTURE, "called");
    const stdout = JSON.stringify([{ files: [{ path: "package.json" }] }]);
    return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  }
  return originalSpawnSync.apply(this, callArgs);
};
syncBuiltinESMExports();
`,
    );

    const result = spawnSync(process.execPath, [resolve(CHECK_SCRIPT), tarball], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
          .filter(Boolean)
          .join(" "),
        OPENCLAW_TEST_NPM_CAPTURE: capturePath,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "unsupported tar entry type SymbolicLink: package/package.json",
    );
    expect(existsSync(capturePath)).toBe(false);
    expect(readFileSync(externalManifestPath)).toEqual(originalBytes);
    expect(statSync(externalManifestPath).mode).toBe(originalMode);
  });

  it("accepts ContiguousFile as a dependency-defined regular entry", () => {
    withTarball(["dist/index.js"], { "dist/index.js": "export {};\n" }, (tarball, _root, root) => {
      writeCraftedTarball(
        tarball,
        listFilesRecursively(root).map((relativePath) => ({
          path: `package/${relativePath.replaceAll("\\", "/")}`,
          type: relativePath === "package.json" ? "ContiguousFile" : "File",
          body: readFileSync(join(root, relativePath)),
        })),
      );
      const result = spawnSync(process.execPath, [resolve(CHECK_SCRIPT), tarball], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    });
  });

  it.each([
    {
      name: "absolute path",
      entries: [{ path: "/package/package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: /package/package.json",
    },
    {
      name: "drive-relative path",
      entries: [{ path: "C:package/package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: C:package/package.json",
    },
    {
      name: "drive-absolute path",
      entries: [{ path: "C:/package/package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: C:/package/package.json",
    },
    {
      name: "UNC path",
      entries: [{ path: "//server/package/package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: //server/package/package.json",
    },
    {
      name: "backslash path",
      entries: [{ path: "package\\package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: package\\package.json",
    },
    {
      name: "PAX backslash path",
      entries: [
        {
          path: "package/package.json",
          type: "File" as const,
          body: "{}\n",
          pax: { path: "package\\package.json" },
        },
      ],
      error: "unsafe tar entry path: package\\package.json",
    },
    {
      name: "PAX final path outside package root",
      entries: [
        {
          path: `package/${"prefix".repeat(16)}/placeholder`,
          type: "File" as const,
          body: "{}\n",
          pax: { path: "evil" },
        },
      ],
      error: "tar entry is outside package/: evil",
    },
    {
      name: "empty path segment",
      entries: [{ path: "package//package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: package//package.json",
    },
    {
      name: "dot segment",
      entries: [{ path: "package/./package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: package/./package.json",
    },
    {
      name: "dotdot segment",
      entries: [{ path: "package/../package.json", type: "File" as const, body: "{}\n" }],
      error: "unsafe tar entry path: package/../package.json",
    },
    {
      name: "outside package root",
      entries: [{ path: "other/package.json", type: "File" as const, body: "{}\n" }],
      error: "tar entry is outside package/: other/package.json",
    },
  ])("rejects crafted archive $name", ({ entries, error }) => {
    checkCraftedTarball(entries, error);
  });

  it.each([
    { type: "SymbolicLink" as const, linkpath: "package/target" },
    { type: "Link" as const, linkpath: "package/target" },
    { type: "CharacterDevice" as const },
    { type: "FIFO" as const },
    { type: "SparseFile" as const },
  ])("rejects crafted $type entries", ({ type, linkpath }) => {
    checkCraftedTarball(
      [{ path: "package/package.json", type, linkpath }],
      `unsupported tar entry type ${type}: package/package.json`,
    );
  });

  it("rejects final PAX link metadata on regular files", () => {
    checkCraftedTarball(
      [
        {
          path: "package/package.json",
          type: "File",
          body: "{}\n",
          pax: { linkpath: "package/target" },
        },
      ],
      "unsupported tar entry type File: package/package.json",
    );
  });

  it.each([
    {
      name: "exact duplicate",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/dist/index.js", type: "File" as const, body: "one\n" },
        { path: "package/dist/index.js", type: "File" as const, body: "two\n" },
      ],
      error: "package tarball contains duplicate paths: package/dist/index.js",
    },
    {
      name: "multiple manifests",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
      ],
      error: [
        "package tarball contains duplicate paths: package/package.json",
        "package tarball must contain exactly one regular package/package.json (found 2)",
      ],
    },
    {
      name: "file-directory conflict",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/dist", type: "File" as const, body: "not a directory\n" },
        { path: "package/dist/", type: "Directory" as const },
      ],
      error: "package tarball contains file-directory conflict: package/dist",
    },
    {
      name: "file-ancestor conflict",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/dist", type: "File" as const, body: "not a directory\n" },
        { path: "package/dist/index.js", type: "File" as const, body: "export {};\n" },
      ],
      error: "package tarball contains file-ancestor conflict: package/dist, package/dist/index.js",
    },
    {
      name: "portable file-ancestor conflict",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/FOO", type: "File" as const, body: "not a directory\n" },
        { path: "package/foo/bar", type: "File" as const, body: "export {};\n" },
      ],
      error: "package tarball contains file-ancestor conflict: package/FOO, package/foo/bar",
    },
    {
      name: "portable case collision",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/README.md", type: "File" as const, body: "one\n" },
        { path: "package/readme.md", type: "File" as const, body: "two\n" },
      ],
      error:
        "package tarball contains portable path collision: package/README.md, package/readme.md",
    },
    {
      name: "portable NFC collision",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/caf\u00e9.txt", type: "File" as const, body: "one\n" },
        { path: "package/cafe\u0301.txt", type: "File" as const, body: "two\n" },
      ],
      error: "package tarball contains portable path collision:",
    },
    {
      name: "Windows encoded-character collision",
      entries: [
        { path: "package/package.json", type: "File" as const, body: "{}\n" },
        { path: "package/a:b", type: "File" as const, body: "one\n" },
        { path: "package/a\uF03Ab", type: "File" as const, body: "two\n" },
      ],
      error: "package tarball contains portable path collision: package/a:b, package/a\uF03Ab",
    },
    {
      name: "missing manifest",
      entries: [{ path: "package/dist/index.js", type: "File" as const, body: "export {};\n" }],
      error: "package tarball must contain exactly one regular package/package.json (found 0)",
    },
    {
      name: "manifest directory",
      entries: [{ path: "package/package.json/", type: "Directory" as const }],
      error: "package tarball must contain exactly one regular package/package.json (found 0)",
    },
  ])("rejects crafted archive with $name", ({ entries, error }) => {
    checkCraftedTarball(entries, error);
  });

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

  it("requires package lifecycle state outside the dist inventory", () => {
    checkTarball({
      version: "0.0.0",
      options: { includeLifecycleMarker: false },
      status: "nonzero",
      stderr: [`missing required tar entry ${PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH}`],
    });

    checkTarball({
      version: "2026.8.2",
      files: {
        "dist/index.js": "export {};\n",
        [LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH]: "pending\n",
      },
      status: "nonzero",
      stderr: [`forbidden legacy tar entry ${LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`],
    });

    checkTarball({
      version: "2026.8.1",
      options: { includeLifecycleMarker: false },
      status: 0,
      stderr: ["legacy package omits the lifecycle pending marker"],
    });

    checkTarball({
      version: "2026.8.1",
      files: {
        "dist/index.js": "export {};\n",
        [PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH]: "export {};\n",
      },
      options: { includeLifecycleMarker: false },
      status: "nonzero",
      stderr: [`missing required tar entry ${PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH}`],
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

  it("accepts the frozen target's declared Plugin SDK compatibility artifacts", () => {
    checkTarball({
      inventory: [
        "dist/extensionAPI.d.ts",
        "dist/extensionAPI.js",
        "dist/plugin-sdk/compat.d.ts",
        "dist/plugin-sdk/compat.js",
        "dist/plugin-sdk/index.d.ts",
        "dist/plugin-sdk/index.js",
        "dist/plugin-sdk/root-alias.cjs",
      ],
      files: {
        "dist/extensionAPI.d.ts": "export {};\n",
        "dist/extensionAPI.js": "export {};\n",
        "dist/plugin-sdk/compat.d.ts": "export {};\n",
        "dist/plugin-sdk/compat.js": "export {};\n",
        "dist/plugin-sdk/index.d.ts": "export {};\n",
        "dist/plugin-sdk/index.js": "export {};\n",
        "dist/plugin-sdk/root-alias.cjs": "module.exports = {};\n",
      },
      version: "2026.6.35",
      options: { postinstall: true },
      status: 0,
      successText: true,
    });
  });

  it.each([
    {
      name: "missing",
      inventoryBody: null,
      stderr: ["missing dist/postinstall-inventory.json"],
    },
    {
      name: "malformed",
      inventoryBody: "{}\n",
      stderr: ["invalid dist/postinstall-inventory.json"],
    },
  ])("fails closed for a $name postinstall inventory", ({ inventoryBody, stderr }) => {
    checkTarball({
      options: { inventoryBody },
      status: "nonzero",
      stderr,
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

  it("rejects a tar entry excluded by npm package metadata", () => {
    const relativePath = "dist/extensions/slack/runtime.js";
    checkTarball({
      inventory: ["dist/index.js", relativePath],
      files: {
        "dist/index.js": "export {};\n",
        [relativePath]: "fixture\n",
      },
      options: {
        packageJson: { files: ["dist", "!dist/extensions/slack/**"] },
      },
      status: "nonzero",
      stderr: [`package tarball contains npm-excluded entries: ${relativePath}`],
    });
  });

  it("accepts entries that npm package metadata re-includes", () => {
    const relativePath = "dist/private/public.js";
    checkTarball({
      inventory: ["dist/index.js", relativePath],
      files: {
        "dist/index.js": "export {};\n",
        [relativePath]: "export {};\n",
      },
      options: {
        packageJson: { files: ["dist", "!dist/private/**", "dist/private/public.js"] },
      },
      status: 0,
      successText: true,
    });
  });

  it("accepts npm-required root files despite package metadata exclusions", () => {
    checkTarball({
      files: {
        "dist/index.js": "export {};\n",
        "README.md": "# OpenClaw\n",
      },
      options: {
        packageJson: { files: ["dist", "!README*"] },
      },
      status: 0,
      successText: true,
    });
  });

  it("rejects package .npmrc without loading its external log policy", () => {
    const packagePath = ".npmrc";
    const externalLogsDir = tempDirs.make("openclaw-npmrc-logs-");
    const sentinelPath = join(externalLogsDir, "2000-01-01T00_00_00_000Z-debug-0.log");
    const sentinelBytes = Buffer.from("must survive npm config loading\n");
    writeFileSync(sentinelPath, sentinelBytes);
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        [packagePath]: [`logs-dir=${externalLogsDir.replaceAll("\\", "/")}`, "logs-max=0", ""].join(
          "\n",
        ),
      },
      (tarball) => {
        const result = spawnSync(process.execPath, [resolve(CHECK_SCRIPT), tarball], {
          encoding: "utf8",
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `package tarball contains npm-excluded entries: ${packagePath}`,
        );
        expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
      },
      undefined,
      {
        filesOnlyArchive: true,
        packageJson: { files: ["dist", packagePath] },
      },
    );
  });

  it("rejects private package cargo independently of package metadata", () => {
    const privatePath = "qa/scenarios/index.yaml";
    checkTarball({
      inventory: ["dist/index.js"],
      files: {
        "dist/index.js": "export {};\n",
        [privatePath]: "id: private\n",
      },
      status: "nonzero",
      stderr: [`npm package must not include private QA suite artifact "${privatePath}".`],
    });
  });

  it("rejects missing static assets declared by packaged extension metadata", () => {
    const extensionManifest = "dist/extensions/example/package.json";
    checkTarball({
      inventory: ["dist/index.js", extensionManifest],
      files: {
        "dist/index.js": "export {};\n",
        [extensionManifest]: JSON.stringify({
          name: "@openclaw/example",
          openclaw: {
            build: {
              staticAssets: [
                {
                  source: "./assets/runtime.js",
                  output: "assets/runtime.js",
                },
              ],
            },
          },
        }),
      },
      options: { postinstall: true },
      status: "nonzero",
      stderr: [
        "declared static extension asset is missing: dist/extensions/example/assets/runtime.js",
      ],
    });
  });

  it("fails closed for malformed packaged extension metadata", () => {
    const extensionManifest = "dist/extensions/example/package.json";
    checkTarball({
      inventory: ["dist/index.js", extensionManifest],
      files: {
        "dist/index.js": "export {};\n",
        [extensionManifest]: "{\n",
      },
      options: { postinstall: true },
      status: "nonzero",
      stderr: ["unreadable packaged extension asset metadata:"],
    });
  });

  it.each([
    "../assets/runtime.js",
    "/assets/runtime.js",
    "C:\\assets\\runtime.js",
    "\\\\server\\share\\runtime.js",
  ])("fails closed for invalid packaged extension asset output %s", (output) => {
    const extensionManifest = "dist/extensions/example/package.json";
    checkTarball({
      inventory: ["dist/index.js", extensionManifest],
      files: {
        "dist/index.js": "export {};\n",
        [extensionManifest]: JSON.stringify({
          name: "@openclaw/example",
          openclaw: {
            build: {
              staticAssets: [
                {
                  source: "./assets/runtime.js",
                  output,
                },
              ],
            },
          },
        }),
      },
      options: { postinstall: true },
      status: "nonzero",
      stderr: [
        "unreadable packaged extension asset metadata:",
        "extension example static asset output must be a package-relative path",
      ],
    });
  });

  it("accepts package-less extension roots without metadata-declared assets", () => {
    const extensionRuntime = "dist/extensions/example/runtime.js";
    const extensionManifest = "dist/extensions/example/openclaw.plugin.json";
    checkTarball({
      inventory: ["dist/index.js", extensionRuntime, extensionManifest],
      files: {
        "dist/index.js": "export {};\n",
        [extensionRuntime]: "export {};\n",
        [extensionManifest]: '{"id":"example"}\n',
      },
      options: { postinstall: true },
      status: 0,
      successText: true,
    });
  });

  it("rejects local package export targets missing from the tarball", () => {
    checkTarball({
      inventory: ["dist/index.js", "dist/plugin-sdk/example.js"],
      files: {
        "dist/index.js": "export {};\n",
        "dist/plugin-sdk/example.js": "export {};\n",
      },
      options: {
        packageJson: {
          exports: {
            ".": "./dist/index.js",
            "./plugin-sdk/example": {
              types: "./dist/plugin-sdk/example.d.ts",
              default: "./dist/plugin-sdk/example.js",
            },
          },
        },
      },
      status: "nonzero",
      stderr: ["package.json export target is missing dist/plugin-sdk/example.d.ts"],
    });
  });

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
      stderr: ["package tarball contains npm-excluded entries: package-lock.json"],
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
      name: "rejects literal package files declarations omitted from the tarball",
      files: { "dist/index.js": "export {};\n" },
      options: {
        packageJson: {
          files: ["dist", "scripts/lib/recommended-tool-installs.json"],
        },
      },
      status: "nonzero",
      stderr: [
        "package.json declares missing tar entry scripts/lib/recommended-tool-installs.json",
      ],
    },
    {
      name: "rejects empty directories for literal package files declarations",
      files: { "dist/index.js": "export {};\n" },
      options: {
        emptyDirectories: ["assets"],
        packageJson: { files: ["dist", "assets"] },
      },
      status: "nonzero",
      stderr: ["package.json declares missing tar entry assets"],
    },
    {
      name: "rejects npm-shrinkwrap.json when package.json does not declare it",
      files: { "dist/index.js": "export {};\n", "npm-shrinkwrap.json": "{}\n" },
      version: "2026.7.33",
      status: "nonzero",
      stderr: ["package tarball must not contain npm-shrinkwrap.json"],
    },
    {
      name: "rejects a package that declares but omits npm-shrinkwrap.json",
      version: "2026.7.33",
      options: {
        includeShrinkwrap: false,
        packageJson: { files: ["dist", "npm-shrinkwrap.json"] },
      },
      status: "nonzero",
      stderr: ["package.json declares missing tar entry npm-shrinkwrap.json"],
    },
  ];
  for (const testCase of packageContractCases) {
    it(testCase.name, () => checkTarball(testCase));
  }

  it("accepts and validates a shrinkwrap declared by the target package", () => {
    const version = "2026.7.33";
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
      options: { packageJson: { files: ["dist", "npm-shrinkwrap.json"] } },
      status: 0,
    });
  });

  const bundledRuntimeCases: NamedTarballCheck[] = [
    {
      name: "accepts npm-selected bundled and hoisted transitive dependency paths",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/example/package.json":
          '{"name":"example","version":"1.0.0","dependencies":{"transitive":"1.0.0"}}\n',
        "node_modules/transitive/package.json": '{"name":"transitive","version":"1.0.0"}\n',
      },
      options: {
        packageJson: {
          files: ["dist"],
          dependencies: { example: "1.0.0" },
          bundleDependencies: ["example"],
        },
      },
      status: 0,
      successText: true,
    },
    {
      name: "rejects an undeclared package nested inside a bundled dependency",
      files: {
        "dist/index.js": "export {};\n",
        "node_modules/example/package.json": '{"name":"example","version":"1.0.0"}\n',
        "node_modules/example/node_modules/extra/package.json":
          '{"name":"extra","version":"1.0.0"}\n',
      },
      options: {
        packageJson: {
          files: ["dist"],
          dependencies: { example: "1.0.0" },
          bundleDependencies: ["example"],
        },
      },
      status: "nonzero",
      stderr: [
        "package tarball contains npm-excluded entries: node_modules/example/node_modules/extra/package.json",
      ],
    },
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
        'npm package must not include local build metadata "dist/.buildstamp".',
        'npm package must not include local build metadata "dist/.runtime-postbuildstamp".',
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
