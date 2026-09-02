// OpenClaw prepack tests validate package prepack output.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { restorePrepackArtifacts } from "../scripts/openclaw-postpack.mjs";
import {
  collectPreparedPrepackErrors,
  collectSourcePackWorkspaceDependencyErrors,
  resolvePrepackAllowUnreleasedChangelog,
  resolvePrepackBuildEnvironment,
  resolvePrepackCommandStdio,
  resolvePrepackCommandTimeoutMs,
  runPrepackCommand,
} from "../scripts/openclaw-prepack.ts";
import { preparePackageDocsMap } from "../scripts/package-docs-map.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rootPackageManager = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager: string;
  }
).packageManager;

const standaloneBundledChannelSmokeFiles = [
  "scripts/test-built-bundled-channel-entry-smoke.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/package-root-args.mts",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/process-warning-filter.mts",
];

function createBundledChannelSmokeFixture(entrySource: string, prepared = false) {
  const rootDir = tempDirs.make("openclaw-prepack-standalone-smoke-");
  for (const relativePath of standaloneBundledChannelSmokeFiles) {
    const destination = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(process.cwd(), relativePath), destination);
  }

  const packageRoot = prepared ? rootDir : path.join(rootDir, "package");
  const extensionRoot = path.join(packageRoot, "dist", "extensions", "fixture-channel");
  mkdirSync(extensionRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), '{"files":[]}\n');
  writeFileSync(
    path.join(extensionRoot, "package.json"),
    `${JSON.stringify({
      name: "@openclaw/fixture-channel",
      openclaw: { channel: true, extensions: ["./index.ts"] },
    })}\n`,
  );
  writeFileSync(path.join(extensionRoot, "index.js"), entrySource);

  return { rootDir, packageRoot };
}

function createPreparedPrepackFixture(entrySource: string) {
  const { rootDir } = createBundledChannelSmokeFixture(entrySource, true);
  mkdirSync(path.join(rootDir, "node_modules"));
  symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(rootDir, "node_modules/tsx"),
    "junction",
  );
  mkdirSync(path.join(rootDir, "docs"));
  mkdirSync(path.join(rootDir, "dist/control-ui/assets"), { recursive: true });
  const sourceFiles = {
    "package.json": '{"name":"openclaw","version":"2026.8.1","type":"module","files":["dist"]}\n',
    "CHANGELOG.md": "# Changelog\n\n## 2026.8.1\n- Current release notes with enough detail.\n",
    "docs/page.md": "# Package docs\n",
    "dist/index.js": "export {};\n",
    "dist/control-ui/index.html": "<!doctype html>\n",
    "dist/control-ui/assets/fixture.js.br": "prepared asset fixture\n",
    "dist/control-ui/assets/fixture.js.gz": "prepared asset fixture\n",
  };
  for (const [name, contents] of Object.entries(sourceFiles)) {
    writeFileSync(path.join(rootDir, name), contents);
  }
  return { rootDir, sourceFiles };
}

function createPrepackLifecycleFixture() {
  const { rootDir, sourceFiles } = createPreparedPrepackFixture(
    'export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: "fixture-channel" }; } };\n',
  );
  const packageJson = JSON.parse(sourceFiles["package.json"]);
  Object.assign(packageJson, {
    packageManager: rootPackageManager,
    files: ["dist", "docs/docs_map.md", "CHANGELOG.md", ".openclaw-lifecycle-pending"],
    devDependencies: { "@openclaw/session-url-contract": "workspace:*" },
    scripts: {
      "build:package": "node rebuild.mjs",
      prepack: "node lifecycle.mjs prepack",
      postpack: "node lifecycle.mjs postpack",
    },
  });
  sourceFiles["package.json"] = `${JSON.stringify(packageJson, null, 2)}\n`;
  sourceFiles["CHANGELOG.md"] += "\n## 2026.7.1\n- Previous release notes with enough detail.\n";
  writeFileSync(path.join(rootDir, "package.json"), sourceFiles["package.json"]);
  writeFileSync(path.join(rootDir, "CHANGELOG.md"), sourceFiles["CHANGELOG.md"]);
  writeFileSync(path.join(rootDir, "docs/docs_map.md"), "Source docs-map stub.\n");
  writeFileSync(
    path.join(rootDir, "rebuild.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync("build-invoked", "build:package\\n");\n' +
      'writeFileSync("dist/index.js", "export const rebuilt = true;\\n");\n',
  );
  writeFileSync(
    path.join(rootDir, "lifecycle.mjs"),
    `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const owner = process.argv[2] === "prepack"
  ? ${JSON.stringify(path.resolve("scripts/openclaw-prepack.ts"))}
  : ${JSON.stringify(path.resolve("scripts/openclaw-postpack.mjs"))};
const result = spawnSync(process.execPath, ["--import", ${JSON.stringify(import.meta.resolve("tsx"))}, owner], { encoding: "utf8" });
writeFileSync(process.argv[2] + "-result.json", JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
  );
  // pnpm may suppress lifecycle output; observe the actual hook before its reporter.
  const readLifecycleResult = (event: "prepack" | "postpack") =>
    JSON.parse(readFileSync(path.join(rootDir, `${event}-result.json`), "utf8")) as {
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    };
  const packDir = path.join(rootDir, "pack");
  mkdirSync(packDir);
  const pack = (prepared: boolean) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    };
    delete env.OPENCLAW_PREPACK_PREPARED;
    if (prepared) {
      env.OPENCLAW_PREPACK_PREPARED = "1";
    }
    return spawnSync("pnpm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const expectRestored = () => {
    for (const name of ["package.json", "CHANGELOG.md"] as const) {
      expect(readFileSync(path.join(rootDir, name), "utf8")).toBe(sourceFiles[name]);
    }
    expect(readFileSync(path.join(rootDir, "docs/docs_map.md"), "utf8")).toBe(
      "Source docs-map stub.\n",
    );
    for (const name of [
      ".openclaw-lifecycle-pending",
      ".artifacts/package-docs-map/receipt.json",
      ".artifacts/package-manifest/package.json.prepack-backup",
      ".artifacts/package-changelog/CHANGELOG.md.prepack-backup",
    ]) {
      expect(existsSync(path.join(rootDir, name)), name).toBe(false);
    }
  };
  return { rootDir, sourceFiles, packDir, pack, readLifecycleResult, expectRestored };
}

type BundledChannelSmokeLayout = "source" | "installed-env" | "installed-path";

function runStandaloneBundledChannelSmoke(entrySource: string, layout: BundledChannelSmokeLayout) {
  const fixture = createBundledChannelSmokeFixture(entrySource);
  const { rootDir } = fixture;
  let { packageRoot } = fixture;
  if (layout === "installed-path") {
    const installedRoot = path.join(rootDir, "node_modules", "openclaw");
    mkdirSync(path.dirname(installedRoot), { recursive: true });
    renameSync(packageRoot, installedRoot);
    packageRoot = installedRoot;
  }
  const temporaryRoot = path.join(rootDir, "smoke-temp");
  mkdirSync(temporaryRoot);
  const sentinelPath = path.join(temporaryRoot, "unrelated.txt");
  writeFileSync(sentinelPath, "preserve caller-owned temporary sibling\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
  };
  delete env.OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT;
  if (layout === "installed-env") {
    env.OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT = "1";
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "scripts", "test-built-bundled-channel-entry-smoke.mts"),
      "--package-root",
      packageRoot,
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    result,
    temporaryEntries: readdirSync(temporaryRoot).toSorted(),
    sentinel: readFileSync(sentinelPath, "utf8"),
    entrySource: readFileSync(
      path.join(packageRoot, "dist", "extensions", "fixture-channel", "index.js"),
      "utf8",
    ),
  };
}

describe("standalone bundled channel smoke", () => {
  const layouts = ["source", "installed-env", "installed-path"] as const;
  it.each(
    layouts.flatMap((layout) => [
      { layout, invalid: false },
      { layout, invalid: true },
    ]),
  )(
    "preserves the result and releases its layout for $layout with invalid=$invalid",
    ({ layout, invalid }) => {
      const entrySource = invalid
        ? "export default [];\n"
        : `export default {
            kind: "bundled-channel-entry",
            loadChannelPlugin() { return { id: "fixture-channel" }; },
          };\n`;
      const observed = runStandaloneBundledChannelSmoke(entrySource, layout);
      const { result } = observed;
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(invalid ? 1 : 0);
      if (invalid) {
        expect(result.stderr).toContain("AssertionError");
        expect(result.stdout).not.toContain("[build-smoke]");
      } else {
        expect(result.stdout).toContain("channel=1");
        expect(result.stdout.match(/\[build-smoke\]/gu)).toHaveLength(1);
      }
      expect(observed.entrySource).toBe(entrySource);
      expect(observed.sentinel).toBe("preserve caller-owned temporary sibling\n");
      expect(observed.temporaryEntries).toEqual(["unrelated.txt"]);
    },
  );
});

describe("prepared prepack ownership", () => {
  it.each([
    { invalid: false, incumbent: true },
    { invalid: true, incumbent: false },
    { invalid: true, incumbent: true },
  ])(
    "does not mutate source when smoke is invalid=$invalid and incumbent=$incumbent",
    async ({ invalid, incumbent }) => {
      const { rootDir, sourceFiles } = createPreparedPrepackFixture(
        invalid
          ? "export default [];\n"
          : 'export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: "fixture-channel" }; } };\n',
      );
      if (incumbent) {
        await preparePackageDocsMap(rootDir);
      }
      const receiptPath = path.join(rootDir, ".artifacts/package-docs-map/receipt.json");
      const receipt = incumbent ? readFileSync(receiptPath, "utf8") : undefined;
      const ownerUrl = pathToFileURL(path.resolve("scripts/openclaw-prepack.ts")).href;
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "--eval",
          `import { preparePrepackArtifacts } from ${JSON.stringify(ownerUrl)}; await preparePrepackArtifacts();`,
        ],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // The package fixture still imports the real owner's workspace source.
            TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(invalid ? "AssertionError" : "PACKAGE_DOCS_MAP_ACTIVE");
      expect(existsSync(path.join(rootDir, ".openclaw-lifecycle-pending"))).toBe(false);
      expect(existsSync(path.join(rootDir, "dist/postinstall-inventory.json"))).toBe(false);
      for (const [name, contents] of Object.entries(sourceFiles)) {
        expect(readFileSync(path.join(rootDir, name), "utf8")).toBe(contents);
      }
      if (incumbent) {
        expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
        await restorePrepackArtifacts(rootDir);
      }
      expect(existsSync(receiptPath)).toBe(false);
    },
  );
});

describe("prepack lifecycle", () => {
  it.each([true, false])("packs and restores source artifacts with prepared=%s", (prepared) => {
    const fixture = createPrepackLifecycleFixture();
    const result = fixture.pack(prepared);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(fixture.rootDir, "build-invoked"))).toBe(!prepared);
    const prepack = fixture.readLifecycleResult("prepack");
    expect(prepack).toMatchObject({ status: 0, signal: null });
    expect(prepack.stdout).toContain("channel=1");
    expect(fixture.readLifecycleResult("postpack")).toMatchObject({ status: 0, signal: null });
    const extractDir = path.join(fixture.rootDir, "extract");
    mkdirSync(extractDir);
    const tarballs = readdirSync(fixture.packDir).filter((name) => name.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    tar.x({ cwd: extractDir, file: path.join(fixture.packDir, tarballs[0]!), sync: true });
    const readPacked = (name: string) =>
      readFileSync(path.join(extractDir, "package", name), "utf8");
    expect(readPacked("dist/index.js")).toBe(
      prepared ? fixture.sourceFiles["dist/index.js"] : "export const rebuilt = true;\n",
    );
    expect(JSON.parse(readPacked("dist/postinstall-inventory.json"))).toContain("dist/index.js");
    expect(readPacked(".openclaw-lifecycle-pending")).toBe("pending\n");
    expect(readPacked("docs/docs_map.md")).toContain("## page.md");
    expect(JSON.parse(readPacked("package.json")).devDependencies).toBeUndefined();
    expect(readPacked("CHANGELOG.md")).toContain("## 2026.8.1");
    expect(readPacked("CHANGELOG.md")).not.toContain("## 2026.7.1");
    fixture.expectRestored();
  });

  it.each(["missing asset", "invalid changelog"])(
    "rejects prepared packages with %s without rebuilding or leaving source mutations",
    (failure) => {
      const fixture = createPrepackLifecycleFixture();
      if (failure === "missing asset") {
        rmSync(path.join(fixture.rootDir, "dist/control-ui/assets/fixture.js.gz"));
      } else {
        fixture.sourceFiles["CHANGELOG.md"] =
          "# Changelog\n\n## 2026.7.1\n- Previous release notes.\n";
        writeFileSync(
          path.join(fixture.rootDir, "CHANGELOG.md"),
          fixture.sourceFiles["CHANGELOG.md"],
        );
      }
      const result = fixture.pack(true);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      const prepack = fixture.readLifecycleResult("prepack");
      expect(prepack).toMatchObject({ status: 1, signal: null });
      expect(prepack.stderr).toContain(
        failure === "missing asset"
          ? "missing prepared Control UI .gz asset"
          : "CHANGELOG.md does not contain a release section for 2026.8.1",
      );
      expect(existsSync(path.join(fixture.rootDir, "build-invoked"))).toBe(false);
      expect(readdirSync(fixture.packDir)).toEqual([]);
      fixture.expectRestored();
    },
  );
});

describe("collectSourcePackWorkspaceDependencyErrors", () => {
  it("rejects the plain source pack that pnpm rewrites without bundling @openclaw/ai", () => {
    const rootDir = tempDirs.make("openclaw-source-pack-workspace-");
    const aiDir = path.join(rootDir, "packages", "ai");
    const packDir = path.join(rootDir, "pack");
    const extractDir = path.join(rootDir, "extract");
    const version = "2099.1.2-test.0";
    const rootPackageJson = {
      dependencies: { "@openclaw/ai": "workspace:*" },
      name: "openclaw-source-pack-regression",
      packageManager: rootPackageManager,
      version,
    };
    mkdirSync(aiDir, { recursive: true });
    mkdirSync(packDir);
    mkdirSync(extractDir);
    writeFileSync(
      path.join(rootDir, "package.json"),
      `${JSON.stringify(rootPackageJson, null, 2)}\n`,
    );
    writeFileSync(path.join(rootDir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      path.join(aiDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/ai", version }, null, 2)}\n`,
    );

    const install = spawnSync("pnpm", ["install", "--ignore-scripts", "--reporter=silent"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(install.status, install.stderr).toBe(0);
    const packed = spawnSync(
      "pnpm",
      ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packDir],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as
      | { filename: string }
      | Array<{
          filename: string;
        }>;
    const filename = Array.isArray(packResult) ? packResult[0]?.filename : packResult.filename;
    expect(filename).toBeTruthy();
    const tarballPath = path.resolve(packDir, path.basename(filename ?? ""));
    tar.x({ cwd: extractDir, file: tarballPath, sync: true });

    const packedPackageJson = JSON.parse(
      readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
    ) as {
      bundleDependencies?: string[];
      dependencies?: Record<string, string>;
    };
    expect(packedPackageJson.dependencies?.["@openclaw/ai"]).toBe(version);
    expect(packedPackageJson.bundleDependencies).toBeUndefined();
    expect(existsSync(path.join(extractDir, "package", "node_modules", "@openclaw", "ai"))).toBe(
      false,
    );
    expect(existsSync(path.join(extractDir, "package", "npm-shrinkwrap.json"))).toBe(false);
    expect(existsSync(path.join(extractDir, "package", "package-lock.json"))).toBe(false);
    expect(collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {})).toEqual([
      "plain root packing cannot safely resolve @openclaw/ai from workspace:*: pnpm rewrites the workspace dependency to an exact version without bundling the package",
      "use `node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog` for a self-contained source package; official npm release automation prepares and publishes @openclaw/ai separately",
    ]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        OPENCLAW_PREPACK_PREPARED: "1",
      }),
    ).toEqual([]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      }),
    ).toEqual([]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: rootDir,
      }),
    ).toHaveLength(2);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "other-npm-wrapper.mjs"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      }),
    ).toHaveLength(2);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "publish",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      }),
    ).toHaveLength(2);
  });

  it("omits build-only workspace dependencies from direct pnpm pack manifests", () => {
    const rootDir = tempDirs.make("openclaw-direct-pack-manifest-");
    const packDir = path.join(rootDir, "pack");
    const extractDir = path.join(rootDir, "extract");
    const scriptsDir = path.join(rootDir, "scripts");
    const originalPackageJson = `${JSON.stringify(
      {
        name: "openclaw-direct-pack-manifest",
        packageManager: rootPackageManager,
        version: "2099.1.2-test.0",
        scripts: {
          prepack: "node scripts/package-manifest.mjs prepare",
          postpack: "node scripts/package-manifest.mjs restore",
          "crabbox:run": "node scripts/crabbox-wrapper.mjs run",
        },
        devDependencies: {
          "@openclaw/session-url-contract": "workspace:*",
          vitest: "4.1.10",
        },
      },
      null,
      2,
    )}\n`;
    mkdirSync(packDir);
    mkdirSync(extractDir);
    mkdirSync(scriptsDir);
    writeFileSync(path.join(rootDir, "package.json"), originalPackageJson);
    copyFileSync(
      path.join(process.cwd(), "scripts", "package-manifest.mjs"),
      path.join(scriptsDir, "package-manifest.mjs"),
    );

    const packed = spawnSync("pnpm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(packed.status, packed.stderr).toBe(0);
    const tarballs = readdirSync(packDir).filter((entry) => entry.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    const tarballName = tarballs[0];
    if (!tarballName) {
      throw new Error("pnpm pack did not produce the expected tarball");
    }
    tar.x({ cwd: extractDir, file: path.join(packDir, tarballName), sync: true });

    const packedPackageJson = JSON.parse(
      readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    expect(packedPackageJson.devDependencies).toEqual({ vitest: "4.1.10" });
    expect(packedPackageJson.scripts?.["crabbox:run"]).toBe("node dist/crabbox-wrapper.js run");
    expect(readFileSync(path.join(rootDir, "package.json"), "utf8")).toBe(originalPackageJson);
    expect(
      existsSync(
        path.join(rootDir, ".artifacts", "package-manifest", "package.json.prepack-backup"),
      ),
    ).toBe(false);
  });
});

describe("resolvePrepackAllowUnreleasedChangelog", () => {
  it("requires an explicit non-publish opt-in", () => {
    for (const raw of [undefined, "", "0", "false"]) {
      expect(
        resolvePrepackAllowUnreleasedChangelog({
          OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: raw,
        }),
      ).toBe(false);
    }
    for (const raw of ["1", "true"]) {
      expect(
        resolvePrepackAllowUnreleasedChangelog({
          OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: raw,
        }),
      ).toBe(true);
    }
    expect(() =>
      resolvePrepackAllowUnreleasedChangelog({
        OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: "yes",
      }),
    ).toThrow("invalid OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: yes");
  });
});

describe("resolvePrepackBuildEnvironment", () => {
  it("pins one timestamp across package and Control UI builds", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(
      resolvePrepackBuildEnvironment(
        {},
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => commit,
      ),
    ).toMatchObject({
      GIT_COMMIT: commit,
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56.000Z",
    });
    expect(
      resolvePrepackBuildEnvironment(
        { OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.7Z" },
        () => new Date("2026-07-11T00:00:00.000Z"),
        () => commit,
      ).OPENCLAW_BUILD_TIMESTAMP,
    ).toBe("2026-07-10T01:02:03.7Z");
  });

  it("normalizes explicit commit aliases and rejects malformed values", () => {
    expect(
      resolvePrepackBuildEnvironment(
        { GIT_SHA: "A".repeat(40) },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => "b".repeat(40),
      ).GIT_COMMIT,
    ).toBe("a".repeat(40));
    expect(() =>
      resolvePrepackBuildEnvironment({ GIT_COMMIT: "deadbeef" }, undefined, () => null),
    ).toThrow("full 40-character hexadecimal SHA");
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const checkedOutCommit = "b".repeat(40);
    const ambientCommit = "a".repeat(40);

    expect(
      resolvePrepackBuildEnvironment(
        { GITHUB_SHA: ambientCommit },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => checkedOutCommit,
      ).GIT_COMMIT,
    ).toBe(checkedOutCommit);
    expect(
      resolvePrepackBuildEnvironment(
        { GITHUB_SHA: ambientCommit },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => null,
      ).GIT_COMMIT,
    ).toBe(ambientCommit);
    expect(() =>
      resolvePrepackBuildEnvironment(
        { GITHUB_SHA: "bad" },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => null,
      ),
    ).toThrow("full 40-character hexadecimal SHA");
  });
});

describe("collectPreparedPrepackErrors", () => {
  it("accepts prepared release artifacts", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        [
          "dist/control-ui/assets/index-Bu8rSoJV.js",
          "dist/control-ui/assets/index-Bu8rSoJV.js.br",
          "dist/control-ui/assets/index-Bu8rSoJV.js.gz",
        ],
      ),
    ).toStrictEqual([]);
  });

  it("rejects a stale Control UI build without precompressed variants", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        ["dist/control-ui/assets/index-Bu8rSoJV.js"],
      ),
    ).toEqual([
      "missing prepared Control UI .br asset under dist/control-ui/assets/",
      "missing prepared Control UI .gz asset under dist/control-ui/assets/",
    ]);
  });

  it("reports missing build and control ui artifacts", () => {
    expect(collectPreparedPrepackErrors([], [])).toEqual([
      "missing required prepared artifact: dist/index.js or dist/index.mjs",
      "missing required prepared artifact: dist/control-ui/index.html",
      "missing prepared Control UI asset payload under dist/control-ui/assets/",
    ]);
  });
});

describe("runPrepackCommand", () => {
  it("keeps prepack child stdout off npm pack JSON stdout", () => {
    expect(resolvePrepackCommandStdio({ stdio: "inherit" }, { npm_config_json: "true" })).toEqual([
      "inherit",
      2,
      "inherit",
    ]);
    expect(
      resolvePrepackCommandStdio(
        { stdio: ["ignore", "pipe", "pipe"] },
        { npm_config_json: "true" },
      ),
    ).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("returns captured output for successful commands", () => {
    const result = runPrepackCommand(process.execPath, ["--eval", "process.stdout.write('ok')"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();
    const result = runPrepackCommand(
      process.execPath,
      ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100,
      },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });
});

describe("resolvePrepackCommandTimeoutMs", () => {
  it("parses only positive integer environment timeouts", () => {
    expect(resolvePrepackCommandTimeoutMs({})).toBe(30 * 60 * 1000);
    expect(resolvePrepackCommandTimeoutMs({ OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: "" })).toBe(
      30 * 60 * 1000,
    );
    expect(resolvePrepackCommandTimeoutMs({ OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: "1234" })).toBe(
      1234,
    );

    for (const raw of ["nope", "10m", "1e3", "0", "-1", "9007199254740992"]) {
      expect(() =>
        resolvePrepackCommandTimeoutMs({ OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: raw }),
      ).toThrow(`invalid OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: ${raw}`);
    }
  });
});
