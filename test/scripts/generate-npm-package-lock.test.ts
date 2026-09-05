import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
// Npm Package Lock Generator tests cover transient npm package-lock behavior.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPackageExtensionPeerMetadata,
  collectOverrideViolations,
  collectPnpmLockViolations,
  createNpmPackageLockInstallStrategyArgs,
  createNpmLockExecOptions,
  createNpmLockCommand,
  disableDependencyShrinkwrapOverrideConflictSources,
  exactOverrideRulesFromOverrides,
  exactVersionFromOverrideSpec,
  normalizeNpmVersionDrift,
  normalizeOverrides,
  packageJsonForNpmLock,
  pnpmLockOverrideVersionForVersions,
  parsePnpmPackageKey,
  parseLockPackagePath,
  resolvePnpmLockOverridePlan,
  resolvePackageDirs,
  resolveNpmLockJobs,
  shouldUseLegacyPeerDepsForNpmLock,
  npmLockPackageDirsForChangedPaths,
} from "../../scripts/generate-npm-package-lock.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("generate-npm-package-lock", () => {
  function repoRelativePath(value: string): string {
    return path.relative(process.cwd(), value).replaceAll("\\", "/");
  }

  it("omits workspace packages that are published beside the package", () => {
    const normalized = packageJsonForNpmLock(
      {
        bundleDependencies: ["chalk"],
        bundledDependencies: ["chalk"],
        dependencies: { "@openclaw/ai": "workspace:2026.6.11", chalk: "5.6.2" },
        devDependencies: { local: "workspace:*" },
        peerDependencies: { host: "workspace:^1.2.3" },
      },
      {},
    );

    expect(normalized).not.toHaveProperty("bundleDependencies");
    expect(normalized).not.toHaveProperty("bundledDependencies");
    expect(normalized).not.toHaveProperty("devDependencies");
    expect(normalized.dependencies).toEqual({ chalk: "5.6.2" });
    expect(normalized.peerDependencies).toEqual({});
  });

  it("runs npm package-lock generation through cmd.exe for Windows npm shims", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    expect(
      createNpmLockCommand(["install", "--package-lock-only"], {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        execPath,
        existsSync: (candidate: string) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", `${npmCmdPath} install --package-lock-only`],
      command: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("bounds npm-lock command runtime and captured output by default", () => {
    expect(
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {}),
    ).toMatchObject({
      cwd: "/tmp/package",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60 * 1000,
    });
  });

  it("adds explicit npm install strategies for package-lock generation", () => {
    expect(createNpmPackageLockInstallStrategyArgs({ installStrategy: "shallow" })).toEqual([
      "--install-strategy=shallow",
    ]);
    expect(createNpmPackageLockInstallStrategyArgs({})).toEqual([]);
    expect(() =>
      createNpmPackageLockInstallStrategyArgs({ installStrategy: "global" as never }),
    ).toThrow("invalid npm package-lock install strategy: global");
  });

  it("normalizes pnpm scoped override selectors for npm package locks", () => {
    expect(
      normalizeOverrides({
        "openclaw@2026.5.28>undici": "8.5.0",
        "parent>unused-adapter": "-",
        tar: 7.5,
      }),
    ).toEqual({
      "openclaw@2026.5.28": {
        undici: "8.5.0",
      },
      tar: "7.5",
    });
  });

  it.each([false, true])(
    "retains parent and child overrides during normalization (childrenFirst=%s)",
    (childrenFirst) => {
      const entries = [
        ["parent", "1.2.3"],
        ["parent>child", "2.0.0"],
        ["parent>sibling", "3.0.0"],
      ];
      expect(
        normalizeOverrides(Object.fromEntries(childrenFirst ? entries.toReversed() : entries)),
      ).toEqual({
        parent: { ".": "1.2.3", child: "2.0.0", sibling: "3.0.0" },
      });
    },
  );

  it("rejects short flag package selectors before resolving npm-lock targets", () => {
    expect(() => resolvePackageDirs(["--package-dir", "-h"])).toThrow(
      "--package-dir requires a package directory.",
    );
    expect(() => resolvePackageDirs(["--changed", "--base", "-h"])).toThrow(
      "--base requires a git ref.",
    );
    expect(() => resolvePackageDirs(["--changed", "--head", "-h"])).toThrow(
      "--head requires a git ref.",
    );
    expect(() => resolvePackageDirs(["--jobs", "-h"])).toThrow(
      "--jobs requires a positive integer.",
    );
  });

  it("validates npm-lock worker counts from flags and environment", () => {
    expect(resolveNpmLockJobs("3", {})).toBe(3);
    expect(resolveNpmLockJobs(undefined, { OPENCLAW_NPM_LOCK_JOBS: "2" })).toBe(2);
    expect(() => resolveNpmLockJobs("0", {})).toThrow("invalid OPENCLAW_NPM_LOCK_JOBS: 0");
    expect(() => resolveNpmLockJobs("17", {})).toThrow("maximum is 16");
  });

  it("accepts strict npm-lock command timeout and buffer overrides", () => {
    expect(
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES: "1048576",
        OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: "30000",
      }),
    ).toMatchObject({
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
  });

  it("rejects loose npm-lock command timeout and buffer overrides", () => {
    expect(() =>
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: "30s",
      }),
    ).toThrow("invalid OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: 30s");
    expect(() =>
      createNpmLockExecOptions({ command: "npm", args: ["install"] }, "/tmp/package", {
        OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES: "64mb",
      }),
    ).toThrow("invalid OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES: 64mb");
  });

  it("extracts exact versions from npm override specs", () => {
    expect(exactVersionFromOverrideSpec("8.4.0")).toBe("8.4.0");
    expect(exactVersionFromOverrideSpec("npm:@nolyfill/domexception@1.0.28")).toBe("1.0.28");
    expect(exactVersionFromOverrideSpec("^8.4.0")).toBeNull();
  });

  it("pins same-line pnpm lock versions to the newest locked patch", () => {
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.38"]))).toBe("3.972.38");
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.38", "3.972.39"]))).toBe("3.972.39");
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.39", "3.973.0"]))).toBeNull();
    expect(pnpmLockOverrideVersionForVersions(new Set(["3.972.39", "4.0.0"]))).toBeNull();
  });

  it("uses scoped forks unless peer contexts conflict under one parent", () => {
    const plan = resolvePnpmLockOverridePlan({
      packages: {
        "@emnapi/core@1.11.1": {},
        "@emnapi/core@1.11.2": {},
        "@types/retry@0.12.0": {},
        "@types/retry@0.12.5": {},
      },
      snapshots: {
        "@napi-rs/wasm-runtime@1.1.6(@emnapi/core@1.11.1)": {
          dependencies: { "@emnapi/core": "1.11.1" },
        },
        "@napi-rs/wasm-runtime@1.1.6(@emnapi/core@1.11.2)": {
          dependencies: { "@emnapi/core": "1.11.2" },
        },
        "@slack/web-api@8.0.0": {
          dependencies: { "@types/retry": "0.12.0" },
        },
        "@types/proper-lockfile@4.1.4": {
          dependencies: { "@types/retry": "0.12.5" },
        },
        "p-retry@4.6.2": {
          dependencies: { "@types/retry": "0.12.0" },
        },
      },
    });

    expect(plan).toEqual({
      conflictingPackageNames: ["@emnapi/core"],
      scopedVersionOverrides: {
        "@slack/web-api@8.0.0": { "@types/retry": "0.12.0" },
        "@types/proper-lockfile@4.1.4": { "@types/retry": "0.12.5" },
        "p-retry@4.6.2": { "@types/retry": "0.12.0" },
      },
      versionOverrides: { "@emnapi/core": "1.11.2" },
    });
  });

  it("parses nested scoped package paths", () => {
    expect(
      parseLockPackagePath("node_modules/@openclaw/codex/node_modules/@anthropic-ai/sdk"),
    ).toEqual([
      {
        name: "@openclaw/codex",
        path: "node_modules/@openclaw/codex",
      },
      {
        name: "@anthropic-ai/sdk",
        path: "node_modules/@openclaw/codex/node_modules/@anthropic-ai/sdk",
      },
    ]);
  });

  it("parses pnpm lock package keys", () => {
    expect(parsePnpmPackageKey("@aws-sdk/core@3.974.12")).toEqual({
      name: "@aws-sdk/core",
      version: "3.974.12",
    });
    expect(parsePnpmPackageKey("react-dom@19.2.4(react@19.2.4)")).toEqual({
      name: "react-dom",
      version: "19.2.4",
    });
    expect(parsePnpmPackageKey("invalid")).toBeNull();
  });

  it("disables embedded shrinkwraps that hide workspace overrides under npm 11", () => {
    const lockfile = {
      packages: {
        "": {
          dependencies: {
            "lru-cache": "^11.5.0",
          },
        },
        "node_modules/@openclaw/codex": {
          version: "0.75.4",
          hasShrinkwrap: true,
        },
        "node_modules/@openclaw/codex/node_modules/protobufjs": {
          version: "7.5.9",
        },
        "node_modules/@openclaw/codex/node_modules/fetch-blob": {
          version: "4.0.0",
        },
        "node_modules/@openclaw/codex/node_modules/fetch-blob/node_modules/node-domexception": {
          version: "1.0.0",
        },
      },
    };
    const overrideRules = exactOverrideRulesFromOverrides({
      protobufjs: "8.4.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });

    expect(collectOverrideViolations(lockfile, overrideRules)).toHaveLength(2);
    expect(disableDependencyShrinkwrapOverrideConflictSources(lockfile, overrideRules)).toEqual([
      "node_modules/@openclaw/codex",
    ]);
    expect(lockfile.packages["node_modules/@openclaw/codex"]).not.toHaveProperty("hasShrinkwrap");
    expect(
      lockfile.packages["node_modules/@openclaw/codex/node_modules/protobufjs"],
    ).toBeUndefined();
  });

  it("detects npm package-lock entries that bypass the pnpm lock", () => {
    const lockfile = {
      packages: {
        "": {},
        "node_modules/react": {
          version: "19.2.6",
        },
        "node_modules/@nolyfill/domexception": {
          version: "1.0.28",
        },
      },
    };
    const pnpmPackages = new Set(["react@19.2.4", "@nolyfill/domexception@1.0.28"]);

    expect(collectPnpmLockViolations(lockfile, pnpmPackages, new Map())).toEqual([
      {
        packageKey: "react@19.2.6",
        path: "node_modules/react",
      },
    ]);
  });

  it("detects npm package-lock integrity drift from the pnpm lock", () => {
    const packageKey = "react@19.2.4";
    expect(
      collectPnpmLockViolations(
        {
          packages: {
            "node_modules/react": {
              version: "19.2.4",
              integrity: "sha512-unreviewed",
            },
          },
        },
        new Set([packageKey]),
        new Map([[packageKey, new Set(["sha512-reviewed"])]]),
      ),
    ).toEqual([
      {
        path: "node_modules/react",
        packageKey,
        actualIntegrity: "sha512-unreviewed",
        expectedIntegrities: ["sha512-reviewed"],
      },
    ]);
  });

  it.each([false, true, "range"])(
    "preserves child override policies when a direct dependency is bound to a local artifact (qualified=%s)",
    (qualified) => {
      const artifact = {
        name: "patched",
        version: "1.0.0",
        spec: "file:./patched.tgz",
        integrity: "sha512-local",
      };
      const manifest = {
        dependencies: { patched: "1.0.0" },
        overrides: qualified
          ? { "patched@1.0.0": { scopedChild: "3.0.0" }, patched: { child: "2.0.0" } }
          : { patched: { child: "2.0.0" }, "patched@1.0.0": { scopedChild: "3.0.0" } },
      };
      const policy = qualified
        ? { "patched@1.0.0": { ".": qualified === "range" ? "^1.0.0" : "1.0.0", child: "2.0.0" } }
        : { patched: "1.0.0" };
      const normalized = packageJsonForNpmLock(manifest, policy, [artifact]);
      expect(normalized.overrides).toEqual({
        "patched@1.0.0": {
          ".": "$patched",
          child: "2.0.0",
          ...(qualified ? { scopedChild: "3.0.0" } : {}),
        },
        patched: { ...(qualified ? {} : { ".": "1.0.0" }), child: "2.0.0" },
      });
      expect(packageJsonForNpmLock(normalized, policy, [artifact])).toEqual(normalized);
      expect(manifest.dependencies.patched).toBe("1.0.0");
    },
  );

  it("preserves wildcard child policies for prerelease artifacts", () => {
    const artifact = {
      name: "patched",
      version: "1.0.0-beta.1",
      spec: "file:./patched.tgz",
      integrity: "sha512-local",
    };
    const normalized = packageJsonForNpmLock(
      {
        dependencies: { patched: artifact.version },
        overrides: { "patched@*": { ".": "*", child: "2.0.0" } },
      },
      {},
      [artifact],
    );
    expect(normalized.overrides).toMatchObject({
      "patched@1.0.0-beta.1": { ".": "$patched", child: "2.0.0" },
    });
  });

  it.each(["conflicting", "disjoint"])(
    "keeps shadowed exact children out of artifact normalization reentry (%s)",
    (scenario) => {
      const artifact = {
        name: "patched",
        version: "1.0.0",
        spec: "file:./patched.tgz",
        integrity: "sha512-local",
      };
      const manifest = {
        dependencies: { patched: "1.0.0" },
        overrides: { "patched@^1.0.0": { ".": "1.0.0", child: "2.0.0" } },
      };
      const policy = {
        "patched@1.0.0": {
          ".": "1.0.0",
          [scenario === "conflicting" ? "child" : "shadowedChild"]: "3.0.0",
        },
      };
      const normalized = packageJsonForNpmLock(manifest, policy, [artifact]);
      expect(normalized.overrides).toMatchObject({
        "patched@1.0.0": { ".": "$patched", child: "2.0.0" },
      });
      expect(packageJsonForNpmLock(normalized, policy, [artifact])).toEqual(normalized);
    },
  );

  it("does not treat an ordinary dependency reference as a normalized artifact", () => {
    expect(() =>
      packageJsonForNpmLock(
        {
          dependencies: { patched: "1.0.0" },
          overrides: { "patched@1.0.0": { ".": "$patched", child: "2.0.0" } },
        },
        { "patched@1.0.0": { ".": "1.0.0", child: "3.0.0" } },
        [
          {
            name: "patched",
            version: "1.0.0",
            spec: "file:./patched.tgz",
            integrity: "sha512-local",
          },
        ],
      ),
    ).toThrow("overrides.child conflicts");
  });

  it.each(["^2.0.0", "npm:other@1.0.0"])(
    "rejects an incompatible artifact own override (%s)",
    (spec) => {
      expect(() =>
        packageJsonForNpmLock(
          { dependencies: { patched: "1.0.0" } },
          { "patched@1.0.0": { ".": spec } },
          [
            {
              name: "patched",
              version: "1.0.0",
              spec: "file:./patched.tgz",
              integrity: "sha512-local",
            },
          ],
        ),
      ).toThrow("local package artifact conflicts with override");
    },
  );

  it("keeps registry integrity checks outside the bound direct artifact occurrence", () => {
    const artifact = {
      name: "patched",
      version: "1.0.0",
      spec: "file:./patched.tgz",
      integrity: "sha512-local",
    };
    expect(
      collectPnpmLockViolations(
        {
          packages: {
            "node_modules/patched": { version: "1.0.0", integrity: artifact.integrity },
            "node_modules/parent/node_modules/patched": {
              version: "1.0.0",
              integrity: artifact.integrity,
            },
            "node_modules/sibling": { version: "1.0.0", integrity: "sha512-tampered" },
          },
        },
        new Set(["patched@1.0.0", "sibling@1.0.0"]),
        new Map([
          ["patched@1.0.0", new Set(["sha512-registry"])],
          ["sibling@1.0.0", new Set(["sha512-sibling"])],
        ]),
        [artifact],
      ),
    ).toEqual([
      {
        path: "node_modules/parent/node_modules/patched",
        packageKey: "patched@1.0.0",
        actualIntegrity: "sha512-local",
        expectedIntegrities: ["sha512-registry"],
      },
      {
        path: "node_modules/sibling",
        packageKey: "sibling@1.0.0",
        actualIntegrity: "sha512-tampered",
        expectedIntegrities: ["sha512-sibling"],
      },
    ]);
  });

  it.each(["valid", "tampered", "wrong-version", "outside-root", "symlink-escape"])(
    "validates real local dependency tarballs before accepting npm locks (%s)",
    (scenario) => {
      const root = tempDirs.make("openclaw-npm-patched-lock-");
      const source = path.join(root, "source");
      const packageDir = path.join(root, "plugin");
      mkdirSync(source);
      mkdirSync(packageDir);
      writeFileSync(path.join(root, "pnpm-workspace.yaml"), "{}\n");
      writeFileSync(
        path.join(root, "pnpm-lock.yaml"),
        JSON.stringify({
          packages: { "fixture-dep@1.0.0": { resolution: { integrity: "sha512-registry" } } },
        }),
      );
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          name: "fixture-dep",
          version: scenario === "wrong-version" ? "2.0.0" : "1.0.0",
          main: "index.js",
        }),
      );
      writeFileSync(path.join(source, "index.js"), "module.exports = 2;\n");
      const pack = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packageDir],
        { cwd: source, encoding: "utf8" },
      );
      expect(pack.status, pack.stderr).toBe(0);
      const packed = JSON.parse(pack.stdout);
      const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);
      const tarball = path.join(packageDir, filename);
      const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
      if (scenario === "tampered") {
        writeFileSync(tarball, "tampered");
      }
      if (scenario === "symlink-escape") {
        const outside = path.join(root, "outside");
        mkdirSync(outside);
        writeFileSync(path.join(outside, filename), readFileSync(tarball));
        symlinkSync(outside, path.join(packageDir, "linked"), "junction");
      }
      const artifact = {
        name: "fixture-dep",
        version: "1.0.0",
        spec:
          scenario === "outside-root"
            ? `file:../plugin/${filename}`
            : scenario === "symlink-escape"
              ? `file:./linked/${filename}`
              : `file:./${filename}`,
        integrity,
      };
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "fixture-plugin",
          version: "1.0.0",
          dependencies: { "fixture-dep": "1.0.0" },
          ...(scenario === "wrong-version"
            ? { overrides: { "fixture-dep": { child: "2.0.0" } } }
            : {}),
        }),
      );
      const script = `import { generateNpmPackageLock } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)}; console.log(generateNpmPackageLock(${JSON.stringify(packageDir)}, { localPackageArtifacts: ${JSON.stringify([artifact])} }));`;
      const result = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root },
        },
      );
      if (scenario === "valid") {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).packages["node_modules/fixture-dep"]).toMatchObject({
          version: "1.0.0",
          integrity,
        });
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          scenario === "tampered"
            ? "local package artifact integrity mismatch"
            : scenario === "wrong-version"
              ? "violates workspace overrides: node_modules/fixture-dep locked 2.0.0, expected 1.0.0"
              : scenario === "symlink-escape"
                ? "local package artifact escapes package root"
                : "invalid local package artifact",
        );
      }
      expect(readFileSync(path.join(source, "index.js"), "utf8")).toBe("module.exports = 2;\n");
    },
  );

  it("normalizes npm patch-version metadata drift", () => {
    expect(
      normalizeNpmVersionDrift({
        packages: {
          "node_modules/@rollup/rollup-linux-x64-gnu": {
            version: "4.53.5",
            cpu: ["x64"],
            libc: ["glibc"],
            optional: true,
            os: ["linux"],
          },
          "node_modules/zod": {
            version: "4.4.3",
            deprecated: "Use another package",
            peer: true,
          },
          "node_modules/keeps-peer-false": {
            version: "1.0.0",
            peer: false,
          },
        },
      }),
    ).toEqual({
      packages: {
        "node_modules/@rollup/rollup-linux-x64-gnu": {
          version: "4.53.5",
          cpu: ["x64"],
          optional: true,
          os: ["linux"],
        },
        "node_modules/zod": {
          version: "4.4.3",
        },
        "node_modules/keeps-peer-false": {
          version: "1.0.0",
          peer: false,
        },
      },
    });
  });

  it("uses legacy peer resolution when package extensions mark dependency peers optional", () => {
    expect(
      shouldUseLegacyPeerDepsForNpmLock(
        { dependencies: { baileys: "7.0.0-rc13" } },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toBe(true);
    expect(
      shouldUseLegacyPeerDepsForNpmLock(
        { dependencies: { "not-baileys": "1.0.0" } },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toBe(false);
  });

  it("uses legacy peer resolution when the package has optional peers", () => {
    expect(
      shouldUseLegacyPeerDepsForNpmLock({
        dependencies: { zod: "4.4.3" },
        peerDependencies: { openclaw: ">=2026.5.30" },
        peerDependenciesMeta: { openclaw: { optional: true } },
      }),
    ).toBe(true);
  });

  it("applies package extension peer metadata to generated npm package locks", () => {
    expect(
      applyPackageExtensionPeerMetadata(
        {
          packages: {
            "node_modules/baileys": {
              version: "7.0.0-rc13",
              peerDependencies: {
                "audio-decode": "^2.1.3",
                sharp: "*",
              },
              peerDependenciesMeta: {
                "audio-decode": { optional: true },
              },
            },
          },
        },
        { baileys: { peerDependenciesMeta: { sharp: { optional: true } } } },
      ),
    ).toEqual({
      packages: {
        "node_modules/baileys": {
          version: "7.0.0-rc13",
          peerDependencies: {
            "audio-decode": "^2.1.3",
            sharp: "*",
          },
          peerDependenciesMeta: {
            "audio-decode": { optional: true },
            sharp: { optional: true },
          },
        },
      },
    });
  });

  it("targets changed publishable plugin manifests", () => {
    expect(
      npmLockPackageDirsForChangedPaths([
        "extensions/acpx/package.json",
        "extensions/acpx/deps/local-runtime/package.json",
      ]).map(repoRelativePath),
    ).toEqual(["extensions/acpx"]);
  });

  it("targets the changed publishable gateway protocol manifest", () => {
    expect(
      npmLockPackageDirsForChangedPaths(["packages/gateway-protocol/package.json"]).map(
        repoRelativePath,
      ),
    ).toEqual(["packages/gateway-protocol"]);
  });

  it("targets the changed publishable gateway client manifest", () => {
    expect(
      npmLockPackageDirsForChangedPaths(["packages/gateway-client/package.json"]).map(
        repoRelativePath,
      ),
    ).toEqual(["packages/gateway-client"]);
  });

  it("falls back to every npm lock when lockfile ownership is ambiguous", () => {
    const packageDirs = npmLockPackageDirsForChangedPaths(["pnpm-lock.yaml"]).map(repoRelativePath);

    expect(packageDirs).toContain("");
    expect(packageDirs).toContain("packages/gateway-client");
    expect(packageDirs).toContain("packages/gateway-protocol");
    expect(packageDirs).toContain("extensions/acpx");
  });

  it("falls back to every npm lock when mixed lockfile changes do not map to packages", () => {
    const packageDirs = npmLockPackageDirsForChangedPaths([
      "extensions/acpx/package.json",
      "pnpm-lock.yaml",
    ]).map(repoRelativePath);

    expect(packageDirs).toContain("");
    expect(packageDirs).toContain("extensions/acpx");
    expect(packageDirs.length).toBeGreaterThan(1);
  });
});
