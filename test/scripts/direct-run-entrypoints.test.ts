import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { isProcessAlive, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import type { runNodeScript } from "../helpers/run-node-script.js";
import {
  formatShimResult,
  TSX_SHIM_WRAPPERS,
  withShimFixture,
} from "./direct-run-entrypoints.test-support.js";

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

function runShimFixture(
  wrapper: (typeof TSX_SHIM_WRAPPERS)[number],
  configureModules: (paths: {
    checkoutRoot: string;
    fixtureRoot: string;
  }) => ModulesEnv = () => ({}),
) {
  return withShimFixture(
    wrapper,
    ({ checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode }) => {
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
      return runNode([wrapperPath, "--hydrated-proof"], env, fixtureRoot);
    },
  );
}

function expectShimLoader(result: Awaited<ReturnType<typeof runShimFixture>>, loader: string) {
  expect(result.error, formatShimResult(result)).toBeUndefined();
  expect(result.status, formatShimResult(result)).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    loader,
    dependency: "loaded",
    args: ["--hydrated-proof"],
  });
}

describe("script direct-run entrypoints", () => {
  it.each([false, true])(
    "preserves preloads when forking into another cwd (equals=%s)",
    async (equals) => {
      await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
        const { checkoutRoot, fixtureRoot, implementationPath, runNode } = fixture;
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
        const result = await runNode(
          [
            ...nodeFlags,
            ...preload,
            ...trailingFlags,
            implementationPath,
            "argument with spaces",
            "--fork-proof",
          ],
          env,
          checkoutRoot,
        );
        expect(result.error, formatShimResult(result)).toBeUndefined();
        expect(result.status, formatShimResult(result)).toBe(17);
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
    async (entrypoint) => {
      await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
        const { fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
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
            const result = await runNode(
              [...launch, "argument with spaces", "--proof"],
              env,
              process.cwd(),
            );
            expect(result.error, formatShimResult(result)).toBeUndefined();
            expect(result.status, formatShimResult(result)).toBe(17);
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
  ] as const)("boots $wrapper from a $mode $envKey", async ({ envKey, mode, wrapper }) => {
    const result = await runShimFixture(wrapper, ({ checkoutRoot, fixtureRoot }) => {
      const modulesDir = path.join(fixtureRoot, "hydrated-modules");
      writeTsxFixture(modulesDir, "hydrated");
      const configuredDir =
        mode === "absolute" ? modulesDir : path.relative(checkoutRoot, modulesDir);
      return { [envKey]: configuredDir };
    });
    expectShimLoader(result, "hydrated");
  });

  it("prefers PNPM_CONFIG_MODULES_DIR over npm_config_modules_dir", async () => {
    const result = await runShimFixture(TSX_SHIM_WRAPPERS[2], ({ fixtureRoot }) => {
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

  it("falls back to checkout dependencies without an external modules directory", async () => {
    expectShimLoader(await runShimFixture(TSX_SHIM_WRAPPERS[3]), "checkout");
  });

  it.each(["hydrated", "primary"] as const)(
    "resolves implementation dependencies from the %s toolchain without local modules",
    async (source) => {
      const result = await runShimFixture(TSX_SHIM_WRAPPERS[0], ({ checkoutRoot, fixtureRoot }) => {
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
    "test/scripts/install-ps1.test.ts",
    "scripts/tsx.mjs",
  ])("routes %s through Windows CI", (changedPath) => {
    expect(detectChangedScope([changedPath]).runWindows).toBe(true);
  });
});

it.each([false, true])(
  "keeps the fixture until its callback settles (reject=%s)",
  async (reject) => {
    const release = createDeferred();
    const failure = new Error("callback rejected after its final write");
    let root = "";
    let finalWrite = "";
    const completion = Promise.resolve(
      withShimFixture(TSX_SHIM_WRAPPERS[0], async ({ fixtureRoot }) => {
        root = fixtureRoot;
        await release.promise;
        const marker = path.join(fixtureRoot, "callback-finished");
        writeFileSync(marker, "finished");
        finalWrite = readFileSync(marker, "utf8");
        if (reject) {
          throw failure;
        }
        return "callback result";
      }),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(existsSync(root), "pending callbacks still own their fixture").toBe(true);
    } finally {
      release.resolve();
      await completion;
    }
    expect(await completion).toEqual(reject ? { error: failure } : { value: "callback result" });
    expect(finalWrite).toBe("finished");
    expect(existsSync(root)).toBe(false);
  },
);

it.each(["callback", "command"])(
  "retains fixture evidence when %s cleanup is unconfirmed",
  async (source) => {
    // Fault injection is limited to the receipt: real OS cleanup failure is unsafe to force.
    const failure = Object.assign(new Error("child cleanup unverified"), {
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
    });
    const runManaged = managedChild.runManagedCommand;
    const spy = vi
      .spyOn(managedChild, "runManagedCommand")
      .mockImplementationOnce(async (options) => {
        await runManaged(options);
        throw failure;
      });
    let root = "";
    try {
      const error = await withShimFixture(
        TSX_SHIM_WRAPPERS[0],
        async ({ fixtureRoot, runNode }) => {
          root = fixtureRoot;
          writeFileSync(path.join(root, "evidence"), "keep");
          if (source === "callback") {
            throw failure;
          }
          await runNode(
            [
              "-e",
              'process.stdout.write("retained stdout"); process.stderr.write("retained stderr");',
            ],
            process.env,
            root,
          );
        },
      ).catch((cause: unknown) => cause);
      expect(existsSync(root), "unverified writers still own the fixture").toBe(true);
      expect(readFileSync(path.join(root, "evidence"), "utf8")).toBe("keep");
      expect(error).toMatchObject({ message: expect.stringContaining(root), cause: failure });
      if (source === "command") {
        const output = readFileSync(path.join(root, "command-output.log"), "utf8");
        expect(output).toContain("retained stdout");
        expect(output).toContain("retained stderr");
        expect(output).toContain("EPROCESSGROUP_CLEANUP_FAILED");
      }
    } finally {
      spy.mockRestore();
      // The real command has joined; only the injected receipt prevents removal.
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("joins owned descendants and captures timeout output before deleting a rejected fixture", async () => {
  const evidence = mkdtempSync(path.join(tmpdir(), "openclaw-shim-owned-pids-"));
  const pidPaths = ["wrapper", "implementation", "descendant"].map((role) =>
    path.join(evidence, `${role}.pid`),
  );
  const wrapperPidProbe = path.join(evidence, "wrapper-pid.mjs");
  writeFileSync(
    wrapperPidProbe,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidPaths[0])}, String(process.pid));`,
  );
  const failure = new Error("fixture callback rejected while the command was running");
  let root = "";
  let command: ReturnType<typeof runNodeScript> | undefined;
  await runQaGatewayFixture(
    async () => {
      const error = await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
        const { fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
        root = fixtureRoot;
        const descendant = `
const fs = require("node:fs");
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(path.join(evidence, "shutdown-root-present"))}, String(fs.existsSync(${JSON.stringify(root)})));
  process.stdout.write("shutdown stdout\\n");
  process.stderr.write("shutdown stderr\\n");
  clearInterval(timer);
});
fs.writeFileSync(${JSON.stringify(pidPaths[2])}, String(process.pid));
process.stdout.write("descendant stdout\\n");
process.stderr.write("descendant stderr\\n");
process.send("ready");
process.disconnect();
`;
        writeFileSync(
          implementationPath,
          `
import fs from "node:fs";
import { spawn } from "node:child_process";
enum Transformed { Value = "transformed" }
console.log(Transformed.Value);
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => fs.writeFileSync(${JSON.stringify(pidPaths[1])}, String(process.pid)));
`,
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PNPM_CONFIG_MODULES_DIR: path.dirname(
            path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
          ),
        };
        delete env.NODE_OPTIONS;
        command = runNode(
          ["--import", pathToFileURL(wrapperPidProbe).href, wrapperPath],
          env,
          fixtureRoot,
        );
        const implementationPid = await waitForPidFile(pidPaths[1]!, 5_000);
        expect(isProcessAlive(implementationPid)).toBe(true);
        throw failure;
      }).catch((cause: unknown) => cause);
      expect(error).toBe(failure);
      expect(command).toBeDefined();
      const result = await command!;
      expect(result.error, formatShimResult(result)).toMatchObject({
        code: "ETIMEDOUT",
        message: "Managed command timed out after 10000ms",
      });
      expect(result.status).toBeNull();
      expect(result.stdout).toContain("transformed");
      expect(result.stdout).toContain("descendant stdout");
      expect(result.stderr).toContain("descendant stderr");
      for (const pidPath of pidPaths) {
        expect(isProcessAlive(Number(readFileSync(pidPath, "utf8"))), pidPath).toBe(false);
      }
      if (process.platform !== "win32") {
        expect(readFileSync(path.join(evidence, "shutdown-root-present"), "utf8")).toBe("true");
        expect(result.stdout).toContain("shutdown stdout");
        expect(result.stderr).toContain("shutdown stderr");
      }
      expect(existsSync(root)).toBe(false);
    },
    async () => {
      await command;
    },
    ...pidPaths.toReversed().map((pidPath) => async () => {
      // Independent recovery also runs after a failed assertion; never rely on the fixture under test.
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8"));
        if (isProcessAlive(pid)) {
          managedChild.terminateManagedChild(
            { pid, kill: (signal) => process.kill(pid, signal) },
            "SIGKILL",
            { useProcessGroup: false },
          );
        }
        await waitForDead(pid, 5_000);
      }
    }),
    () => {
      if (
        pidPaths.some(
          (pidPath) => existsSync(pidPath) && isProcessAlive(Number(readFileSync(pidPath, "utf8"))),
        )
      ) {
        throw new Error(`Owned proof children remain; retained PID evidence ${evidence}`);
      }
      rmSync(evidence, { recursive: true, force: true });
    },
  );
});
