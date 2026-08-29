import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";

const DIRECT_RUN_SCRIPTS = [
  "scripts/android-app-i18n.ts",
  "scripts/android-pin-version.ts",
  "scripts/ci-run-timings.mjs",
  "scripts/e2e/lib/package-compat.mjs",
  "scripts/generate-bundled-channel-config-metadata.ts",
  "scripts/plan-release-workflow-matrix.mjs",
  "scripts/run-additional-boundary-checks.mts",
  "scripts/verify-docker-attestations.mjs",
] as const;

const EXECUTABLE_ENTRYPOINTS = [
  {
    args: ["--direct-run-smoke"],
    output: "Unknown CI run timing option: --direct-run-smoke",
    script: "scripts/ci-run-timings.mjs",
    status: 1,
  },
  {
    args: ["2026.4.25"],
    output: "1",
    script: "scripts/e2e/lib/package-compat.mjs",
    status: 0,
  },
  {
    args: ["--clawhub-release-security-mode", "2026.6.35"],
    output: "absent",
    script: "scripts/e2e/lib/package-compat.mjs",
    status: 0,
  },
  {
    args: ["--clawhub-release-security-mode", "2026.8.1"],
    output: "required",
    script: "scripts/e2e/lib/package-compat.mjs",
    status: 0,
  },
  {
    args: [],
    output: "docker_e2e_count=",
    script: "scripts/plan-release-workflow-matrix.mjs",
    status: 0,
  },
  {
    args: ["--help"],
    output: "Usage: node --import tsx scripts/run-additional-boundary-checks.mts",
    script: "scripts/run-additional-boundary-checks.mts",
    status: 0,
  },
  {
    args: ["--help"],
    output: "Usage: node scripts/verify-docker-attestations.mjs",
    script: "scripts/verify-docker-attestations.mjs",
    status: 0,
  },
] as const;

function runEntrypoint(entrypoint: (typeof EXECUTABLE_ENTRYPOINTS)[number]) {
  const script = path.resolve(entrypoint.script);
  const args = script.endsWith(".mts")
    ? ["--import", "tsx", script, ...entrypoint.args]
    : [script, ...entrypoint.args];
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_LANES: "",
      GITHUB_STEP_SUMMARY: "",
      INCLUDE_LIVE_SUITES: "",
      INCLUDE_RELEASE_PATH_SUITES: "",
      LIVE_MODEL_PROVIDERS: "",
      LIVE_SUITE_FILTER: "",
      RELEASE_TEST_PROFILE: "",
    },
    timeout: 30_000,
  });
}

const TSX_SHIM_WRAPPERS = [
  "scripts/run-vitest.mjs",
  "scripts/lib/plugin-npm-package-manifest.mjs",
  "scripts/e2e/kitchen-sink-rpc-walk.mjs",
  "scripts/perf/summarize-cpuprofile.mjs",
] as const;

type ModulesEnv = Partial<Record<"PNPM_CONFIG_MODULES_DIR" | "npm_config_modules_dir", string>>;

function writeTsxFixture(modulesDir: string, marker: string) {
  const packageDir = path.join(modulesDir, "tsx");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: "./loader.mjs" }),
  );
  writeFileSync(
    path.join(packageDir, "loader.mjs"),
    `process.env.OPENCLAW_TSX_FIXTURE_LOADER = ${JSON.stringify(marker)};\n`,
  );
  const dependencyDir = path.join(modulesDir, "shim-dependency");
  mkdirSync(dependencyDir, { recursive: true });
  writeFileSync(
    path.join(dependencyDir, "package.json"),
    JSON.stringify({ name: "shim-dependency", type: "module", exports: "./index.js" }),
  );
  writeFileSync(path.join(dependencyDir, "index.js"), 'export const value = "loaded";\n');
}

function withShimFixture<T>(
  wrapper: (typeof TSX_SHIM_WRAPPERS)[number],
  run: (paths: {
    checkoutRoot: string;
    fixtureRoot: string;
    implementationPath: string;
    wrapperPath: string;
  }) => T,
) {
  const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-tsx-cli-shim-")));
  const checkoutRoot = path.join(fixtureRoot, "checkout");
  const wrapperPath = path.join(checkoutRoot, wrapper);
  const implementationPath = wrapperPath.replace(/\.mjs$/u, ".mts");
  try {
    mkdirSync(path.dirname(wrapperPath), { recursive: true });
    mkdirSync(path.join(checkoutRoot, "scripts", "lib"), { recursive: true });
    copyFileSync(wrapper, wrapperPath);
    copyFileSync("scripts/tsx.mjs", path.join(checkoutRoot, "scripts", "tsx.mjs"));
    copyFileSync(
      "scripts/lib/tsx-cli-shim.mjs",
      path.join(checkoutRoot, "scripts", "lib", "tsx-cli-shim.mjs"),
    );
    copyFileSync(
      "scripts/lib/local-check-runtime.mts",
      path.join(checkoutRoot, "scripts", "lib", "local-check-runtime.mts"),
    );
    writeFileSync(path.join(checkoutRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return run({ checkoutRoot, fixtureRoot, implementationPath, wrapperPath });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function runShimFixture(
  wrapper: (typeof TSX_SHIM_WRAPPERS)[number],
  configureModules: (paths: {
    checkoutRoot: string;
    fixtureRoot: string;
  }) => ModulesEnv = () => ({}),
) {
  return withShimFixture(
    wrapper,
    ({ checkoutRoot, fixtureRoot, implementationPath, wrapperPath }) => {
      writeFileSync(
        implementationPath,
        'import { value } from "shim-dependency";\nprocess.stdout.write(JSON.stringify({ loader: process.env.OPENCLAW_TSX_FIXTURE_LOADER, dependency: value, args: process.argv.slice(2) }));\n',
      );
      writeTsxFixture(path.join(checkoutRoot, "node_modules"), "checkout");
      const modulesEnv = configureModules({ checkoutRoot, fixtureRoot });

      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      delete env.PNPM_CONFIG_MODULES_DIR;
      delete env.npm_config_modules_dir;
      Object.assign(env, modulesEnv);
      return spawnSync(process.execPath, [wrapperPath, "--hydrated-proof"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
    },
  );
}

function expectShimLoader(result: ReturnType<typeof runShimFixture>, loader: string) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    loader,
    dependency: "loaded",
    args: ["--hydrated-proof"],
  });
}

describe("script direct-run entrypoints", () => {
  it.each([false, true])(
    "preserves preloads when forking into another cwd (equals=%s)",
    (equals) => {
      withShimFixture(TSX_SHIM_WRAPPERS[0], ({ checkoutRoot, fixtureRoot, implementationPath }) => {
        const forkCwd = path.join(fixtureRoot, "child cwd");
        mkdirSync(forkCwd);
        const childPath = path.join(fixtureRoot, "fork-child.mts");
        const extraPreloadPath = path.join(fixtureRoot, "extra-preload.mjs");
        writeFileSync(extraPreloadPath, 'globalThis.fixturePreload = "preserved";\n');
        const snapshotSource = `
enum Transformed { Value = "transformed" }
console.log(JSON.stringify({ transformed: Transformed.Value, preload: globalThis.fixturePreload,
  args: process.argv.slice(2), cwd: process.cwd(), execArgv: process.execArgv }));
`;
        writeFileSync(childPath, `${snapshotSource}\nprocess.exitCode = 17;\n`);
        writeFileSync(
          implementationPath,
          `${snapshotSource}
import { fork } from "node:child_process";
const child = fork(${JSON.stringify(childPath)}, process.argv.slice(2), {
  cwd: ${JSON.stringify(forkCwd)}, stdio: "inherit",
});
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", code => resolve(code ?? 1));
});
`,
        );
        const nodeFlags = ["--no-warnings", "--import", pathToFileURL(extraPreloadPath).href];
        const trailingFlags = ["--title", "./scripts/tsx.mjs", "--import=node:fs"];
        const preload = equals ? ["--import=./scripts/tsx.mjs"] : ["--import", "./scripts/tsx.mjs"];
        const bootstrapUrl = pathToFileURL(path.join(checkoutRoot, "scripts/tsx.mjs")).href;
        const expectedPreload = equals ? [`--import=${bootstrapUrl}`] : ["--import", bootstrapUrl];
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TMPDIR: fixtureRoot,
          TMP: fixtureRoot,
          TEMP: fixtureRoot,
          PNPM_CONFIG_MODULES_DIR: path.dirname(
            path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
          ),
        };
        delete env.TSX_DISABLE_CACHE;
        delete env.NODE_OPTIONS;
        const result = spawnSync(
          process.execPath,
          [
            ...nodeFlags,
            ...preload,
            ...trailingFlags,
            implementationPath,
            "argument with spaces",
            "--fork-proof",
          ],
          {
            cwd: checkoutRoot,
            encoding: "utf8",
            env,
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(17);
        expect(
          result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          [checkoutRoot, forkCwd].map((cwd) => ({
            transformed: "transformed",
            preload: "preserved",
            args: ["argument with spaces", "--fork-proof"],
            cwd,
            execArgv: [...nodeFlags, ...expectedPreload, ...trailingFlags],
          })),
        );
      });
    },
  );

  it.each(["wrapper", "root package preloads"])(
    "keeps %s and raw tsx children off disk caches without changing other cache settings",
    (entrypoint) => {
      withShimFixture(TSX_SHIM_WRAPPERS[0], ({ fixtureRoot, implementationPath, wrapperPath }) => {
        const require = createRequire(import.meta.url);
        const modulesDir = path.dirname(path.dirname(require.resolve("tsx/package.json")));
        const tempRoot = path.join(fixtureRoot, "temp");
        const cacheRoots = ["tsx", `tsx-${process.geteuid?.() ?? userInfo().username}`].map(
          (name) => path.join(tempRoot, name),
        );
        for (const cacheRoot of cacheRoots) {
          mkdirSync(cacheRoot, { recursive: true });
          writeFileSync(path.join(cacheRoot, "0-sentinel"), "keep");
        }
        const accessLog = path.join(fixtureRoot, "cache-access.log");
        const guard = path.join(fixtureRoot, "cache-guard.cjs");
        writeFileSync(
          guard,
          `
const fs = require("node:fs");
const path = require("node:path");
const readdirSync = fs.readdirSync;
fs.readdirSync = function (directory, ...args) {
  if (/^tsx(?:-|$)/.test(path.basename(String(directory)))) {
    fs.appendFileSync(${JSON.stringify(accessLog)}, "cache scan\\n");
    throw new Error("Unexpected tsx disk cache access");
  }
  return readdirSync.call(this, directory, ...args);
};
`,
        );
        const preservedEnv = Object.fromEntries(
          [
            "TMPDIR",
            "TMP",
            "TEMP",
            "XDG_CACHE_HOME",
            "NODE_COMPILE_CACHE",
            "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH",
          ].map((key) => [
            key,
            key === "TMPDIR" || key === "TEMP" ? tempRoot : path.join(fixtureRoot, key),
          ]),
        );
        const childPath = path.join(fixtureRoot, "child.mts");
        const snapshotSource = `
enum Transformed { Value = "transformed" }
console.log(JSON.stringify({
  transformed: Transformed.Value,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(${JSON.stringify(Object.keys(preservedEnv))}.map(key => [key, process.env[key]])),
}));
`;
        writeFileSync(childPath, `${snapshotSource}\nprocess.exitCode = 17;\n`);
        writeFileSync(
          implementationPath,
          `${snapshotSource}
import { spawnSync } from "node:child_process";
const child = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(childPath)}, ...process.argv.slice(2)], { stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
`,
        );
        const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
          scripts: Record<string, string>;
        };
        const preloads = [
          ...new Set(
            Object.values(scripts).flatMap((command) =>
              [...command.matchAll(/--import(?:=|\s+)(\S+)/gu)].map((match) => match[1]!),
            ),
          ),
        ];
        expect(preloads.length).toBeGreaterThan(0);
        const launches =
          entrypoint === "wrapper"
            ? [[wrapperPath]]
            : preloads.map((preload) => ["--import", preload, implementationPath]);
        for (const cacheFlag of [undefined, ""]) {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...preservedEnv,
            PNPM_CONFIG_MODULES_DIR: modulesDir,
            NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
          };
          delete env.TSX_DISABLE_CACHE;
          if (cacheFlag !== undefined) {
            env.TSX_DISABLE_CACHE = cacheFlag;
          }
          for (const launch of launches) {
            const result = spawnSync(
              process.execPath,
              [...launch, "argument with spaces", "--proof"],
              {
                cwd: process.cwd(),
                encoding: "utf8",
                env,
                timeout: 10_000,
              },
            );
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(17);
            expect(
              result.stdout
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line)),
            ).toEqual(
              Array.from({ length: 2 }, () => ({
                transformed: "transformed",
                args: ["argument with spaces", "--proof"],
                cwd: process.cwd(),
                env: preservedEnv,
              })),
            );
            if (entrypoint === "wrapper") {
              expect(result.stderr.trim().split("\n").at(-1)).toBe("[test] FAILED (exit 17)");
            }
          }
        }
        expect(existsSync(accessLog)).toBe(false);
        for (const cacheRoot of cacheRoots) {
          expect(readdirSync(cacheRoot)).toEqual(["0-sentinel"]);
          expect(readFileSync(path.join(cacheRoot, "0-sentinel"), "utf8")).toBe("keep");
        }
      });
    },
  );

  it.each(EXECUTABLE_ENTRYPOINTS)("runs $script through its guarded CLI", (entrypoint) => {
    const result = runEntrypoint(entrypoint);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(entrypoint.status);
    expect(output).toContain(entrypoint.output);
  });

  it.each([
    { envKey: "PNPM_CONFIG_MODULES_DIR", mode: "absolute", wrapper: TSX_SHIM_WRAPPERS[0] },
    { envKey: "npm_config_modules_dir", mode: "relative", wrapper: TSX_SHIM_WRAPPERS[1] },
    { envKey: "PNPM_CONFIG_MODULES_DIR", mode: "relative", wrapper: TSX_SHIM_WRAPPERS[2] },
    { envKey: "npm_config_modules_dir", mode: "absolute", wrapper: TSX_SHIM_WRAPPERS[3] },
  ] as const)("boots $wrapper from a $mode $envKey", ({ envKey, mode, wrapper }) => {
    const result = runShimFixture(wrapper, ({ checkoutRoot, fixtureRoot }) => {
      const modulesDir = path.join(fixtureRoot, "hydrated-modules");
      writeTsxFixture(modulesDir, "hydrated");
      const configuredDir =
        mode === "absolute" ? modulesDir : path.relative(checkoutRoot, modulesDir);
      return { [envKey]: configuredDir };
    });
    expectShimLoader(result, "hydrated");
  });

  it("prefers PNPM_CONFIG_MODULES_DIR over npm_config_modules_dir", () => {
    const result = runShimFixture(TSX_SHIM_WRAPPERS[2], ({ fixtureRoot }) => {
      const preferredDir = path.join(fixtureRoot, "preferred-modules");
      const fallbackDir = path.join(fixtureRoot, "fallback-modules");
      writeTsxFixture(preferredDir, "preferred");
      writeTsxFixture(fallbackDir, "lowercase");
      return {
        PNPM_CONFIG_MODULES_DIR: preferredDir,
        npm_config_modules_dir: fallbackDir,
      };
    });
    expectShimLoader(result, "preferred");
  });

  it("falls back to checkout dependencies without an external modules directory", () => {
    expectShimLoader(runShimFixture(TSX_SHIM_WRAPPERS[3]), "checkout");
  });

  it.each(["hydrated", "primary"] as const)(
    "resolves implementation dependencies from the %s toolchain without local modules",
    (source) => {
      const result = runShimFixture(TSX_SHIM_WRAPPERS[0], ({ checkoutRoot, fixtureRoot }) => {
        rmSync(path.join(checkoutRoot, "node_modules"), { recursive: true });
        const primaryRoot = path.join(fixtureRoot, "primary");
        const modulesDir = path.join(primaryRoot, "node_modules");
        writeTsxFixture(modulesDir, source);
        if (source === "hydrated") {
          return { PNPM_CONFIG_MODULES_DIR: modulesDir };
        }
        const initialized = spawnSync(
          "git",
          ["init", "--quiet", "--separate-git-dir", path.join(primaryRoot, ".git"), checkoutRoot],
          { encoding: "utf8" },
        );
        expect(initialized.status, initialized.stderr).toBe(0);
        return {};
      });
      expectShimLoader(result, source);
    },
  );

  it("matches Windows drive paths case-insensitively", () => {
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\android-app-i18n.ts",
        "c:\\repo\\scripts\\android-app-i18n.ts",
        "win32",
      ),
    ).toBe(true);
  });

  it.each(DIRECT_RUN_SCRIPTS)("uses the canonical guard in %s", (script) => {
    const source = readFileSync(script, "utf8");

    expect(source.match(/isDirectRunUrl\(process\.argv\[1\], import\.meta\.url\)/gu)).toHaveLength(
      1,
    );
  });

  it.each([
    ...DIRECT_RUN_SCRIPTS,
    "scripts/lib/direct-run.mjs",
    "scripts/lib/tsx-cli-shim.mjs",
    "test/scripts/direct-run-entrypoints.test.ts",
    "scripts/tsx.mjs",
  ])("routes %s through Windows CI", (changedPath) => {
    expect(detectChangedScope([changedPath]).runWindows).toBe(true);
  });
});
