// Package OpenClaw For Docker tests cover QA Lab package artifact evidence.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "../../../../scripts/lib/bundled-plugin-build-entries.mjs";
import { writePackageDistInventoryForPublish } from "../../../../scripts/lib/package-dist-inventory.ts";
import {
  preparePackageDocsMap,
  restorePackageDocsMap,
} from "../../../../scripts/package-docs-map.mjs";
import {
  preparePackageManifest,
  restorePackageManifest,
} from "../../../../scripts/package-manifest.mjs";
import {
  buildPackageArtifacts,
  packOpenClawPackageForDocker,
  parseArgs,
  prepareBundledAiRuntimePackage,
  runCaptureForTest,
  runCommandForTest,
  writePackageInventoryForDocker,
} from "../../../../scripts/package-openclaw-for-docker.mts";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const skipBundledAiRuntime = async (): Promise<() => Promise<void>> => async () => {};
// Fake-tarball tests write placeholder bytes that the real mode normalizer
// could not parse as a gzip archive.
const skipTarballModeNormalization = { normalizeTarballModes: async (): Promise<void> => {} };
const skipDocsMapLifecycle = {
  prepareDocsMap: async (): Promise<void> => {},
  restoreDocsMap: async (): Promise<void> => {},
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tsxImport = import.meta.resolve("tsx");

function createPackageSourceFixture(prefix: string) {
  const sourceDir = tempDirs.make(prefix);
  fs.mkdirSync(path.join(sourceDir, "scripts"));
  fs.mkdirSync(path.join(sourceDir, "node_modules"));
  // The inventory child runs from this fixture; inherit its source owner's workspace aliases.
  fs.writeFileSync(
    path.join(sourceDir, "tsconfig.json"),
    JSON.stringify({ extends: path.resolve("tsconfig.json") }),
  );
  // Run the canonical inventory producer against this fixture's files.
  // Only tsx is linked; AI staging must retain its own writable node_modules tree.
  const inventoryUrl = pathToFileURL(path.resolve("scripts/lib/package-dist-inventory.ts")).href;
  fs.writeFileSync(
    path.join(sourceDir, "scripts/write-package-dist-inventory.ts"),
    `import(${JSON.stringify(inventoryUrl)}).then(({ writePackageDistInventoryForPublish }) => writePackageDistInventoryForPublish(process.cwd()));\n`,
  );
  fs.symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(sourceDir, "node_modules/tsx"),
    "junction",
  );
  return sourceDir;
}

function createSelectedPluginPackageFixture() {
  const sourceDir = createPackageSourceFixture("openclaw-selected-plugin-source-");
  const outputDir = tempDirs.make("openclaw-selected-plugin-output-");
  const packageJson = {
    name: "openclaw",
    version: "2026.8.1",
    files: [
      "dist",
      ".openclaw-lifecycle-pending",
      "!dist/extensions/demo/**",
      "!dist/extensions/other/**",
      "!dist/extensions/*/node_modules/**",
    ],
    dependencies: { shared: "1.0.0" },
  };
  const pluginPackage = {
    name: "@openclaw/demo",
    version: packageJson.version,
    dependencies: { shared: "1.0.0", native: "2.0.0" },
    optionalDependencies: { optional: "3.0.0" },
    peerDependencies: { peer: "1.0.0" },
    peerDependenciesMeta: { peer: { optional: true } },
    openclaw: { extensions: ["./index.ts"], release: { publishToNpm: true } },
  };
  const files = {
    "package.json": JSON.stringify(packageJson),
    "extensions/demo/package.json": JSON.stringify(pluginPackage),
    "extensions/demo/openclaw.plugin.json": '{"id":"demo"}',
    "extensions/demo/index.ts": "export {};",
    "dist/extensions/demo/package.json": JSON.stringify({
      ...pluginPackage,
      openclaw: { ...pluginPackage.openclaw, extensions: ["./index.js"] },
    }),
    "dist/extensions/demo/openclaw.plugin.json": '{"id":"demo"}',
    "dist/extensions/demo/index.js": 'export { value } from "../../shared-runtime.js";',
    "dist/extensions/demo/node_modules/host-native/index.js": "not portable",
    "dist/extensions/other/index.js": "not selected",
    "dist/shared-runtime.js": "export const value = 42;",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { sourceDir, outputDir, files, pluginPackage };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readPid(filePath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const pid = Number(fs.readFileSync(filePath, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for a positive pid in ${filePath}`);
}

async function expectCommandTimeoutAfterReady(
  start: () => Promise<string>,
  ready: (commandEnded: AbortSignal) => Promise<void>,
  timeoutMs = 500,
): Promise<void> {
  const realSetTimeout = globalThis.setTimeout;
  const deadlines: Array<() => void> = [];
  const expire = () => {
    for (const deadline of deadlines.splice(0)) {
      deadline();
    }
  };
  // Hold only the command deadline until the real child has installed its handlers.
  // Restore scheduling before readiness polling and all real termination/grace work.
  const timerSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, milliseconds, ...args) => {
      if (milliseconds !== timeoutMs) {
        return realSetTimeout(callback, milliseconds, ...args);
      }
      const timer = realSetTimeout(() => {}, milliseconds);
      deadlines.push(() => {
        clearTimeout(timer);
        callback(...args);
      });
      return timer;
    });
  try {
    let runPromise: Promise<string>;
    try {
      runPromise = start();
    } finally {
      timerSpy.mockRestore();
    }
    const commandEnded = new AbortController();
    void runPromise.then(
      () => commandEnded.abort(new Error("Command exited before readiness")),
      (error: unknown) => commandEnded.abort(error),
    );
    // Observe rejection before the first await, and join both outcomes before cleanup.
    const results = await Promise.allSettled([
      expect(runPromise).rejects.toThrow(`timed out after ${timeoutMs}ms`),
      (async () => {
        try {
          expect(deadlines).toHaveLength(1);
          await ready(commandEnded.signal);
        } finally {
          expire();
        }
      })(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  } finally {
    expire();
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process still alive: ${pid}`);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ signal: NodeJS.Signals | null; status: number | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timeout waiting for child exit")),
      timeoutMs,
    );
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ signal, status });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("package-openclaw-for-docker", () => {
  it("packs explicitly selected plugin runtime and dependencies without changing the ordinary package", async () => {
    const { sourceDir, outputDir, files } = createSelectedPluginPackageFixture();
    const inventoryPath = path.join(sourceDir, "dist/postinstall-inventory.json");
    const options = {
      ...skipDocsMapLifecycle,
      prepareChangelog: async () => {},
      restoreChangelog: async () => {},
    };
    const selected = await packOpenClawPackageForDocker(sourceDir, outputDir, {
      ...options,
      bundlePlugins: ["demo"],
    });
    const extractDir = tempDirs.make("openclaw-selected-plugin-extract-");
    await tar.x({ file: selected, cwd: extractDir });
    const packedRoot = path.join(extractDir, "package");
    expect(fs.readFileSync(path.join(packedRoot, ".openclaw-lifecycle-pending"), "utf8")).toBe(
      "pending\n",
    );
    expect(fs.existsSync(path.join(packedRoot, "dist/extensions/demo/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(packedRoot, "dist/shared-runtime.js"))).toBe(true);
    expect(fs.existsSync(path.join(packedRoot, "dist/extensions/other/index.js"))).toBe(false);
    expect(fs.existsSync(path.join(packedRoot, "dist/extensions/demo/node_modules"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(packedRoot, "package.json"), "utf8")),
    ).toMatchObject({
      dependencies: { shared: "1.0.0", native: "2.0.0" },
      optionalDependencies: { optional: "3.0.0" },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(packedRoot, "dist/postinstall-inventory.json"), "utf8")),
    ).toContain("dist/extensions/demo/index.js");
    expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(
      files["package.json"],
    );
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))).toEqual(["dist/shared-runtime.js"]);
    expect(fs.existsSync(path.join(sourceDir, ".openclaw-lifecycle-pending"))).toBe(false);

    const ordinary = await packOpenClawPackageForDocker(sourceDir, outputDir, options);
    const ordinaryEntries: string[] = [];
    await tar.t({ file: ordinary, onentry: (entry) => ordinaryEntries.push(entry.path) });
    expect(ordinaryEntries).toContain("package/.openclaw-lifecycle-pending");
    expect(ordinaryEntries.some((entry) => entry.startsWith("package/dist/extensions/demo/"))).toBe(
      false,
    );
  });
  it.runIf(process.platform === "win32")(
    "runs npm through the toolchain-local runner on Windows",
    async () => {
      const output = await runCommandForTest("npm", ["--version"], process.cwd(), {
        captureStdout: true,
        timeoutMs: 30_000,
      });

      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
    },
  );

  it.skipIf(process.platform === "win32").each(["pnpm", "corepack"])(
    "resolves pnpm from POSIX PATH through %s without inheriting another runner",
    async (tool) => {
      const tempDir = tempDirs.make("openclaw-package-corepack-runner-");
      const bin = path.join(tempDir, "bin");
      const inherited = path.join(tempDir, "inherited", "pnpm");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.dirname(inherited));
      fs.symlinkSync(process.execPath, inherited);
      // Reuse the running interpreter instead of executing a newly created script.
      // Its input filename records the Corepack prefix as part of the actual argv.
      fs.symlinkSync(process.execPath, path.join(bin, tool));
      for (const entry of ["pnpm", "probe"]) {
        fs.writeFileSync(
          path.join(tempDir, entry),
          "console.log(JSON.stringify({ command: process.argv0, args: [require('node:path').basename(process.argv[1]), ...process.argv.slice(2)] }));\n",
        );
      }
      const output = await runCommandForTest("pnpm", ["probe", "value with spaces"], tempDir, {
        captureStdout: true,
        env: { ...process.env, PATH: bin, npm_execpath: inherited },
        timeoutMs: 30_000,
      });
      const prefix = tool === "corepack" ? ["pnpm"] : [];
      const result = JSON.parse(output) as { command: string; args: string[] };
      expect(path.basename(result.command)).toBe(tool);
      expect(result.command).not.toBe(inherited);
      expect(result.args).toEqual([...prefix, "probe", "value with spaces"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "runs pnpm.cmd through the portable runner on Windows",
    async () => {
      const tempDir = tempDirs.make("openclaw-package-pnpm-runner-");
      fs.writeFileSync(
        path.join(tempDir, "pnpm.cmd"),
        '@echo off\r\nif "%~1"=="probe" echo package-pnpm-runner-ok\r\n',
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === "PATH" || key.toUpperCase() === "PATHEXT") {
          delete env[key];
        }
      }
      env.PATH = tempDir;
      env.PATHEXT = ".CMD";
      env.npm_execpath = "";

      const output = await runCommandForTest("pnpm", ["probe"], tempDir, {
        captureStdout: true,
        env,
        timeoutMs: 30_000,
      });

      expect(output.trim()).toBe("package-pnpm-runner-ok");
    },
  );

  it.runIf(process.platform === "win32")(
    "kills pnpm.cmd descendants when the package command times out",
    async ({ signal }) => {
      const tempDir = tempDirs.make("openclaw-package-pnpm-timeout-");
      const childPidPath = path.join(tempDir, "child.pid");
      const childScriptPath = path.join(tempDir, "child.cjs");
      fs.writeFileSync(
        childScriptPath,
        [
          "const fs = require('node:fs');",
          "const pidPath = process.env.OPENCLAW_TEST_CHILD_PID;",
          "fs.writeFileSync(pidPath + '.tmp', String(process.pid));",
          "fs.renameSync(pidPath + '.tmp', pidPath);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tempDir, "pnpm.cmd"),
        `@echo off\r\n"${process.execPath}" "${childScriptPath}"\r\n`,
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === "PATH" || key.toUpperCase() === "PATHEXT") {
          delete env[key];
        }
      }
      env.PATH = tempDir;
      env.PATHEXT = ".CMD";
      env.npm_execpath = "";
      env.OPENCLAW_TEST_CHILD_PID = childPidPath;

      let childPid = 0;
      const readiness = fs.watch(tempDir);
      try {
        await expectCommandTimeoutAfterReady(
          () =>
            runCommandForTest("pnpm", ["probe"], tempDir, {
              env,
              killAfterMs: 25,
              timeoutMs: 500,
            }),
          async (commandEnded) => {
            const readinessSignal = AbortSignal.any([signal, commandEnded]);
            while (!fs.existsSync(childPidPath)) {
              await once(readiness, "change", { signal: readinessSignal });
            }
            childPid = Number(fs.readFileSync(childPidPath, "utf8"));
            expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
          },
        );
        await waitForDead(childPid, 2_000);
      } finally {
        readiness.close();
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it("parses package artifact output options", () => {
    expect(
      parseArgs([
        "--output-dir",
        ".artifacts/docker",
        "--output-name=openclaw-current.tgz",
        "--pack-json",
        ".artifacts/docker/pack.json",
        "--source-dir",
        "/repo",
        "--allow-unreleased-changelog",
        "--skip-build",
      ]),
    ).toEqual({
      allowUnreleasedChangelog: true,
      bundlePlugins: [],
      outputDir: ".artifacts/docker",
      outputName: "openclaw-current.tgz",
      packJson: ".artifacts/docker/pack.json",
      pnpmPack: false,
      skipBuild: true,
      sourceDir: "/repo",
    });
  });

  it("rejects missing package artifact option values", () => {
    for (const flag of [
      "--output-dir",
      "--output-name",
      "--pack-json",
      "--source-dir",
      "--bundle-plugin",
    ]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--skip-build"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([`${flag}=`])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([`${flag}=-h`])).toThrow(`${flag} requires a value`);
    }
  });

  it("accepts repeatable explicit plugin selections", () => {
    expect(parseArgs(["--bundle-plugin", "demo", "--bundle-plugin=other"]).bundlePlugins).toEqual([
      "demo",
      "other",
    ]);
  });

  it.each([
    {
      args: ["--output-dir=one", "--output-dir"],
      message: "--output-dir requires a value",
    },
    {
      args: ["--output-name=../bad.tgz", "--invalid"],
      message: "unknown argument: --invalid",
    },
    {
      args: ["--output-name=../bad.tgz", "--output-name=valid.tgz"],
      message: "--output-name was provided more than once",
    },
    {
      args: ["--output-name=../bad.tgz", "--pack-json=pack.json", "--pnpm-pack"],
      message: "--output-name must be a tarball filename, not a path: ../bad.tgz",
    },
    {
      args: ["--pack-json=pack.json", "--pnpm-pack", "--invalid"],
      message: "unknown argument: --invalid",
    },
    { args: ["--"], message: "unknown argument: --" },
    { args: ["--skip-build=true"], message: "unknown argument: --skip-build=true" },
  ])("preserves argument error precedence for $args", ({ args, message }) => {
    expect(() => parseArgs(args)).toThrow(new Error(message));
  });

  it("builds explicit plugin selections through the canonical build environment", async () => {
    const { sourceDir } = createSelectedPluginPackageFixture();
    const runImpl = vi.fn(
      async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        expect(options.env?.[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]).toBe("demo");
        expect(fs.existsSync(path.join(sourceDir, "dist"))).toBe(false);
      },
    );
    await buildPackageArtifacts(sourceDir, { bundlePlugins: ["demo", "demo"], runImpl });
    expect(runImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { failure: "missing-entry", metadata: {} },
    { failure: "stale-metadata", metadata: { version: "2026.7.1" } },
    { failure: "stale-peer-dependencies", metadata: { peerDependencies: { missing: "1.0.0" } } },
    { failure: "stale-peer-meta", metadata: { peerDependenciesMeta: {} } },
  ])("rejects $failure in a selected built plugin", async ({ failure, metadata }) => {
    const { sourceDir, outputDir, files, pluginPackage } = createSelectedPluginPackageFixture();
    if (failure === "missing-entry") {
      fs.rmSync(path.join(sourceDir, "dist/extensions/demo/index.js"));
    } else {
      fs.writeFileSync(
        path.join(sourceDir, "dist/extensions/demo/package.json"),
        JSON.stringify({ ...pluginPackage, ...metadata }),
      );
    }
    const runCaptureImpl = vi.fn(async () => {
      throw new Error("unexpected pack");
    });
    await expect(
      packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipDocsMapLifecycle,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        prepareBundledAiRuntime: skipBundledAiRuntime,
        bundlePlugins: ["demo"],
        runCaptureImpl,
      }),
    ).rejects.toThrow(failure === "missing-entry" ? /ENOENT/ : /does not match source metadata/);
    expect(runCaptureImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(
      files["package.json"],
    );
  });

  it.each([
    { id: "../outside", error: /invalid plugin id/ },
    { id: "missing", error: /unknown plugin id/ },
    { id: "demo,other", error: /unknown plugin id/ },
  ])("rejects invalid selected plugin $id before packing", async ({ id, error }) => {
    const { sourceDir, outputDir, files } = createSelectedPluginPackageFixture();
    const runCaptureImpl = vi.fn();
    await expect(
      packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipDocsMapLifecycle,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        bundlePlugins: [id],
        runCaptureImpl,
      }),
    ).rejects.toThrow(error);
    expect(runCaptureImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(
      files["package.json"],
    );
  });

  it.each([
    { spec: "2.0.0", error: /must declare shared@2.0.0/ },
    { spec: "^1.0.0", error: /requires an exact dependency pin/ },
  ])(
    "rejects selected plugin dependency $spec without resolving a replacement",
    async ({ spec, error }) => {
      const { sourceDir, outputDir, files, pluginPackage } = createSelectedPluginPackageFixture();
      pluginPackage.dependencies.shared = spec;
      for (const prefix of ["extensions", "dist/extensions"]) {
        fs.writeFileSync(
          path.join(sourceDir, prefix, "demo/package.json"),
          JSON.stringify(pluginPackage),
        );
      }
      await expect(
        packOpenClawPackageForDocker(sourceDir, outputDir, {
          ...skipDocsMapLifecycle,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
          bundlePlugins: ["demo"],
        }),
      ).rejects.toThrow(error);
      expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(
        files["package.json"],
      );
      expect(
        JSON.parse(
          fs.readFileSync(path.join(sourceDir, "dist/postinstall-inventory.json"), "utf8"),
        ),
      ).toEqual(["dist/shared-runtime.js"]);
    },
  );

  it("restores selected package metadata and inventory after npm pack fails", async () => {
    const { sourceDir, outputDir, files } = createSelectedPluginPackageFixture();
    const runCaptureImpl = vi.fn(async () => {
      throw new Error("pack rejected");
    });
    await expect(
      packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipDocsMapLifecycle,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        bundlePlugins: ["demo"],
        runCaptureImpl,
      }),
    ).rejects.toThrow("pack rejected");
    expect(runCaptureImpl).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(
      files["package.json"],
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(sourceDir, "dist/postinstall-inventory.json"), "utf8")),
    ).toEqual(["dist/shared-runtime.js"]);
    expect(fs.existsSync(path.join(sourceDir, "dist/openclaw-install-guard"))).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, ".openclaw-lifecycle-pending"))).toBe(false);
  });

  it("rejects duplicate package artifact CLI options", () => {
    const duplicateCases = [
      ["--output-dir", ["--output-dir", "one", "--output-dir=two"]],
      ["--output-name", ["--output-name", "one.tgz", "--output-name=two.tgz"]],
      ["--pack-json", ["--pack-json", "one.json", "--pack-json=two.json"]],
      [
        "--allow-unreleased-changelog",
        ["--allow-unreleased-changelog", "--allow-unreleased-changelog"],
      ],
      ["--pnpm-pack", ["--pnpm-pack", "--pnpm-pack"]],
      ["--source-dir", ["--source-dir", "/repo-a", "--source-dir=/repo-b"]],
      ["--skip-build", ["--skip-build", "--skip-build"]],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("loads from a trusted harness checkout without installed dependencies", async () => {
    const tempRoot = tempDirs.make("openclaw-package-harness-");
    const copiedFiles = [
      "scripts/package-openclaw-for-docker.mts",
      "scripts/package-changelog.mjs",
      "scripts/package-docs-map.mjs",
      "scripts/package-source-dependencies.mjs",
      "scripts/docs-list.js",
      "scripts/npm-runner.mts",
      "scripts/pnpm-runner.mts",
      "scripts/windows-cmd-helpers.mjs",
      "scripts/lib/arg-utils.runtime.mjs",
      "scripts/lib/bundled-plugin-build-entries.mjs",
      "scripts/lib/bundled-plugin-paths.mjs",
      "scripts/lib/error-format.mts",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/vitest-resource-ownership.mts",
      "scripts/lib/npm-json-output.mts",
      "scripts/lib/optional-bundled-clusters.mjs",
      "scripts/lib/output-root-guard.mjs",
      "scripts/lib/package-lifecycle-marker.mjs",
      "scripts/lib/record-shared.mjs",
      "scripts/lib/release-notes-compaction.mjs",
      "scripts/lib/root-package-bundled-plugin-excludes.mjs",
      "scripts/lib/windows-cmd-helpers-runtime.mts",
      "scripts/lib/windows-taskkill.mjs",
    ];
    try {
      for (const relativePath of copiedFiles) {
        const target = path.join(tempRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(relativePath, target);
      }
      const result = await new Promise<{ status: number | null; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              tsxImport,
              path.join(tempRoot, "scripts/package-openclaw-for-docker.mts"),
              "--invalid",
            ],
            { cwd: tempRoot, stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.on("error", reject);
          child.on("close", (status) => resolve({ status, stderr }));
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unknown argument: --invalid");
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("writes inventory for a frozen source checkout without the trusted helper", async () => {
    const sourceDir = tempDirs.make("openclaw-package-frozen-source-");
    fs.mkdirSync(path.join(sourceDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "node_modules", "tsx"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "package.json"), '{"name":"openclaw"}\n');
    fs.writeFileSync(
      path.join(sourceDir, "node_modules", "tsx", "package.json"),
      '{"name":"tsx","exports":"./loader.mjs","type":"module"}\n',
    );
    fs.writeFileSync(path.join(sourceDir, "node_modules", "tsx", "loader.mjs"), "export {};\n");
    fs.writeFileSync(path.join(sourceDir, "dist", "entry.js"), "export {};\n");
    fs.writeFileSync(path.join(sourceDir, "dist", "not-in-frozen-inventory.js"), "export {};\n");
    fs.writeFileSync(
      path.join(sourceDir, "scripts", "write-package-dist-inventory.ts"),
      [
        'import fs from "node:fs";',
        'fs.writeFileSync("dist/postinstall-inventory.json", JSON.stringify(["dist/entry.js"]));',
      ].join("\n"),
    );

    await writePackageInventoryForDocker(
      sourceDir,
      async (command: string, args: string[], cwd: string) => {
        expect({ command, cwd }).toEqual({ command: "node", cwd: sourceDir });
        expect(args).toEqual([
          "--import",
          pathToFileURL(fs.realpathSync(path.join(sourceDir, "node_modules", "tsx", "loader.mjs")))
            .href,
          path.join(sourceDir, "scripts", "write-package-dist-inventory.ts"),
        ]);
        await runCommandForTest(command, args, cwd);
      },
    );

    expect(
      JSON.parse(
        fs.readFileSync(path.join(sourceDir, "dist", "postinstall-inventory.json"), "utf8"),
      ),
    ).toEqual(["dist/entry.js"]);
    expect(fs.existsSync(path.join(sourceDir, "scripts", "lib", "package-dist-inventory.ts"))).toBe(
      false,
    );
  });

  it("rejects pnpm pack with npm metadata output", () => {
    expect(parseArgs(["--pnpm-pack"]).pnpmPack).toBe(true);
    expect(() => parseArgs(["--pnpm-pack", "--pack-json", "pack.json"])).toThrow(
      "--pack-json cannot be combined with --pnpm-pack",
    );
  });

  it("rejects package artifact output names that escape the output directory", () => {
    for (const outputName of [
      "../openclaw-current.tgz",
      "nested/openclaw-current.tgz",
      "openclaw-current.zip",
      ".openclaw-current.tgz",
    ]) {
      expect(() => parseArgs(["--output-name", outputName])).toThrow(
        `--output-name must be a tarball filename, not a path: ${outputName}`,
      );
    }

    expect(parseArgs(["--output-name", "openclaw-current.tar.gz"]).outputName).toBe(
      "openclaw-current.tar.gz",
    );
  });

  it("uses the source package build entrypoint with declaration generation", async () => {
    const sourceDir = tempDirs.make("openclaw-package-build-source-");
    const calls: Array<{
      command: string;
      args: string[];
      cwd: string;
      noPnpm: string | undefined;
      packageExtensions: string | undefined;
      dockerBuildExtensions: string | undefined;
      internalDockerBuildPluginIds: string | undefined;
      privateQa: string | undefined;
      skipDts: string | undefined;
      timeoutMs: number | undefined;
    }> = [];
    const previousTimeout = process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS;
    const previousSkipDts = process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD;
    const previousPackageExtensions = process.env.OPENCLAW_EXTENSIONS;
    const previousDockerBuildExtensions = process.env.OPENCLAW_DOCKER_BUILD_EXTENSIONS;
    const previousInternalPluginIds = process.env[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV];
    const previousPrivateQa = process.env.OPENCLAW_BUILD_PRIVATE_QA;
    process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS = "1234";
    process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = "1";
    process.env.OPENCLAW_EXTENSIONS = "clickclack";
    process.env.OPENCLAW_DOCKER_BUILD_EXTENSIONS = "slack";
    process.env[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV] = "msteams";
    process.env.OPENCLAW_BUILD_PRIVATE_QA = "1";

    try {
      await buildPackageArtifacts(sourceDir, {
        runImpl: async (
          command: string,
          args: string[],
          cwd: string,
          options: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
        ) => {
          calls.push({
            command,
            args,
            cwd,
            noPnpm: options.env?.OPENCLAW_BUILD_ALL_NO_PNPM,
            packageExtensions: options.env?.OPENCLAW_EXTENSIONS,
            dockerBuildExtensions: options.env?.OPENCLAW_DOCKER_BUILD_EXTENSIONS,
            internalDockerBuildPluginIds: options.env?.[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV],
            privateQa: options.env?.OPENCLAW_BUILD_PRIVATE_QA,
            skipDts: options.env?.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD,
            timeoutMs: options.timeoutMs,
          });
        },
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS = previousTimeout;
      }
      if (previousSkipDts === undefined) {
        delete process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD;
      } else {
        process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = previousSkipDts;
      }
      for (const [envName, previousValue] of [
        ["OPENCLAW_EXTENSIONS", previousPackageExtensions],
        ["OPENCLAW_DOCKER_BUILD_EXTENSIONS", previousDockerBuildExtensions],
        [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV, previousInternalPluginIds],
        ["OPENCLAW_BUILD_PRIVATE_QA", previousPrivateQa],
      ] as const) {
        if (previousValue === undefined) {
          delete process.env[envName];
        } else {
          process.env[envName] = previousValue;
        }
      }
    }

    expect(calls).toEqual([
      {
        command: "pnpm",
        args: ["run", "build"],
        cwd: sourceDir,
        dockerBuildExtensions: undefined,
        internalDockerBuildPluginIds: undefined,
        noPnpm: "1",
        packageExtensions: undefined,
        privateQa: undefined,
        skipDts: "0",
        timeoutMs: 1234,
      },
    ]);
  });

  it("omits stale hashed dist output when frozen sources expose only their own build", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-package-clean-dist-source-");
    const outputDir = tempDirs.make("openclaw-package-clean-dist-output-");
    const stalePath = path.join(sourceDir, "dist", "runtime-OLDHASH.js");
    fs.mkdirSync(path.dirname(stalePath));
    fs.writeFileSync(stalePath, "export const stale = true;\n");
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      `${JSON.stringify(
        {
          files: ["dist"],
          name: "openclaw",
          scripts: {
            build:
              "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.js','export {};\\n')\"",
          },
          version: "2026.4.25",
        },
        null,
        2,
      )}\n`,
    );

    await buildPackageArtifacts(sourceDir);
    const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
      ...skipDocsMapLifecycle,
      prepareChangelog: async () => {},
      restoreChangelog: async () => {},
    });
    const entries: string[] = [];
    await tar.t({
      file: tarball,
      onentry: (entry) => entries.push(entry.path),
    });

    expect(entries).toContain("package/dist/index.js");
    expect(entries).not.toContain("package/dist/runtime-OLDHASH.js");
  });

  it.skipIf(process.platform === "win32")(
    "reports the final artifact after normalizing owner-only packed modes",
    async () => {
      const sourceDir = createPackageSourceFixture("openclaw-package-modes-source-");
      const outputDir = tempDirs.make("openclaw-package-modes-output-");
      const distDir = path.join(sourceDir, "dist");
      // A restrictive-umask build host leaves owner-only sources on disk;
      // npm pack copies these modes verbatim into the tarball.
      fs.mkdirSync(distDir, { mode: 0o700 });
      fs.writeFileSync(path.join(distDir, "index.js"), "export {};\n", { mode: 0o600 });
      fs.writeFileSync(path.join(sourceDir, "openclaw.mjs"), "#!/usr/bin/env node\n", {
        mode: 0o700,
      });
      fs.writeFileSync(
        path.join(sourceDir, "package.json"),
        `${JSON.stringify({
          bin: { openclaw: "openclaw.mjs" },
          files: ["dist", "openclaw.mjs"],
          name: "openclaw",
          version: "2026.8.26",
        })}\n`,
      );

      const tarball = await withEnvAsync({ npm_config_json: "true" }, async () =>
        packOpenClawPackageForDocker(sourceDir, outputDir, {
          ...skipDocsMapLifecycle,
          outputName: "openclaw-current.tgz",
          packJsonPath: path.join(outputDir, "pack.json"),
          prepareBundledAiRuntime: skipBundledAiRuntime,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
        }),
      );

      const entryModes = new Map<string, number>();
      const files: Array<{ path: string; size: number; mode: number }> = [];
      const extendedAttributeHeaders: string[] = [];
      const parser = new tar.Parser({
        onReadEntry: (entry) => {
          const mode = (entry.mode ?? 0) & 0o777;
          entryModes.set(entry.path, mode);
          files.push({ path: entry.path.replace(/^package\//u, ""), size: entry.size, mode });
          entry.resume();
        },
      });
      // ReadEntry drops unknown PAX fields, so inspect the raw header keys.
      parser.on("meta", (metadata: string) => {
        extendedAttributeHeaders.push(
          ...(metadata.match(/(?:LIBARCHIVE|SCHILY)\.xattr\.[^=\n]+(?==)/gu) ?? []),
        );
      });
      const parsed = once(parser, "end");
      const bytes = fs.readFileSync(tarball);
      parser.end(bytes);
      await parsed;
      expect(extendedAttributeHeaders).toEqual([]);
      expect(entryModes.get("package/dist/index.js")).toBe(0o644);
      expect(entryModes.get("package/openclaw.mjs")).toBe(0o755);
      expect(entryModes.get("package/package.json")).toBe(0o644);
      const receipt = JSON.parse(fs.readFileSync(path.join(outputDir, "pack.json"), "utf8"));
      expect(receipt).toEqual([
        expect.objectContaining({
          filename: path.basename(tarball),
          size: bytes.length,
          shasum: createHash("sha1").update(bytes).digest("hex"),
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          entryCount: files.length,
          files: expect.arrayContaining(files),
        }),
      ]);
      expect(receipt[0].files).toHaveLength(files.length);
      expect(fs.readdirSync(outputDir).toSorted()).toEqual(["openclaw-current.tgz", "pack.json"]);
    },
  );

  it("rejects loose package artifact timeout env values", async () => {
    const previousTimeout = process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS;
    try {
      for (const value of ["1e3", "123.9", "9007199254740993", "0"]) {
        process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS = value;

        await expect(
          buildPackageArtifacts("/repo", {
            runImpl: async () => undefined,
          }),
        ).rejects.toThrow(
          "OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS must be a positive timeout in milliseconds",
        );
      }
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("bundles and restores the separately packed AI runtime", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-ai-source-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-ai-output-"));
    const packageJsonPath = path.join(sourceDir, "package.json");
    const originalPackageJson = `${JSON.stringify(
      {
        dependencies: { "@openclaw/ai": "workspace:*", "dep-a": "workspace:1.2.3" },
        devDependencies: { "@openclaw/session-url-contract": "workspace:*" },
        files: ["dist"],
        name: "openclaw",
        version: "2026.6.17",
      },
      null,
      2,
    )}\n`;
    const installedAiPath = path.join(sourceDir, "node_modules", "@openclaw", "ai");
    const aiPackageJsonPath = path.join(sourceDir, "packages", "ai", "package.json");
    const originalAiPackageJson =
      '{"name":"@openclaw/ai","version":"2026.6.17","devDependencies":{"@openclaw/normalization-core":"workspace:*"}}\n';
    fs.mkdirSync(path.join(sourceDir, "packages", "ai"), { recursive: true });
    fs.writeFileSync(aiPackageJsonPath, originalAiPackageJson);
    fs.mkdirSync(installedAiPath, { recursive: true });
    fs.writeFileSync(path.join(installedAiPath, "original-marker"), "workspace package");
    fs.writeFileSync(packageJsonPath, originalPackageJson);

    try {
      const cleanup = await prepareBundledAiRuntimePackage(
        sourceDir,
        outputDir,
        async (command: string, args: string[], cwd: string) => {
          expect({ args, command, cwd }).toEqual({
            args: [
              "--dir",
              "packages/ai",
              "pack",
              "--loglevel=error",
              "--use-stderr",
              "--pack-destination",
              outputDir,
            ],
            command: "pnpm",
            cwd: sourceDir,
          });
          expect(
            JSON.parse(fs.readFileSync(aiPackageJsonPath, "utf8")).devDependencies,
          ).toBeUndefined();
          fs.writeFileSync(path.join(outputDir, "openclaw-ai-2026.6.17.tgz"), "ai package");
          return "";
        },
        {
          extractAiRuntime: async (_tarballPath: string, destination: string) => {
            fs.writeFileSync(
              path.join(destination, "package.json"),
              `${JSON.stringify({
                dependencies: {
                  "@openclaw/private-runtime": "0.0.0-private",
                  "dep-a": "1.2.3",
                },
                name: "@openclaw/ai",
                version: "2026.6.17",
              })}\n`,
            );
            fs.writeFileSync(path.join(destination, "runtime.js"), "export {};\n");
          },
          prepareManifest: preparePackageManifest,
          restoreManifest: restorePackageManifest,
        },
      );

      expect(fs.readFileSync(aiPackageJsonPath, "utf8")).toBe(originalAiPackageJson);
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        bundleDependencies: string[];
        dependencies: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(packageJson.dependencies["@openclaw/ai"]).toBe("2026.6.17");
      expect(packageJson.dependencies["@openclaw/private-runtime"]).toBeUndefined();
      expect(packageJson.dependencies["dep-a"]).toBe("1.2.3");
      expect(packageJson.devDependencies?.["@openclaw/session-url-contract"]).toBe("workspace:*");
      expect(packageJson.bundleDependencies).toContain("@openclaw/ai");
      expect(fs.existsSync(path.join(installedAiPath, "original-marker"))).toBe(false);
      expect(fs.existsSync(path.join(installedAiPath, "runtime.js"))).toBe(true);
      const stagedAiPackageJson = JSON.parse(
        fs.readFileSync(path.join(installedAiPath, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      expect(stagedAiPackageJson.dependencies).toBeUndefined();

      await cleanup();
      expect(fs.readFileSync(packageJsonPath, "utf8")).toBe(originalPackageJson);
      expect(fs.readFileSync(path.join(installedAiPath, "original-marker"), "utf8")).toBe(
        "workspace package",
      );
      expect(fs.existsSync(path.join(outputDir, "openclaw-ai-2026.6.17.tgz"))).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps real AI runtime pack failures visible for installer diagnostics", async () => {
    const sourceDir = tempDirs.make("openclaw-docker-ai-failure-source-");
    const outputDir = tempDirs.make("openclaw-docker-ai-failure-output-");
    const packageJsonPath = path.join(sourceDir, "package.json");
    const originalPackageJson = `${JSON.stringify({
      dependencies: { "@openclaw/ai": "workspace:*" },
      name: "openclaw",
    })}\n`;
    const aiPackageJsonPath = path.join(sourceDir, "packages", "ai", "package.json");
    const originalAiPackageJson =
      '{"name":"@openclaw/ai","devDependencies":{"@openclaw/normalization-core":"workspace:*"}}\n';
    fs.mkdirSync(path.join(sourceDir, "packages", "ai"), { recursive: true });
    fs.writeFileSync(aiPackageJsonPath, originalAiPackageJson);
    fs.writeFileSync(packageJsonPath, originalPackageJson);
    const packError = new Error("AI pack failed");

    await expect(
      prepareBundledAiRuntimePackage(
        sourceDir,
        outputDir,
        async () => {
          throw packError;
        },
        {
          prepareManifest: preparePackageManifest,
          restoreManifest: restorePackageManifest,
        },
      ),
    ).rejects.toBe(packError);
    expect(fs.readFileSync(aiPackageJsonPath, "utf8")).toBe(originalAiPackageJson);
    expect(fs.readFileSync(packageJsonPath, "utf8")).toBe(originalPackageJson);

    const restoreError = new Error("AI manifest restore failed");
    await expect(
      prepareBundledAiRuntimePackage(
        sourceDir,
        outputDir,
        async () => {
          throw packError;
        },
        {
          prepareManifest: preparePackageManifest,
          restoreManifest: async (cwd) => {
            await restorePackageManifest(cwd);
            throw restoreError;
          },
        },
      ),
    ).rejects.toMatchObject({ cause: packError, errors: [packError, restoreError] });
  });

  it("reuses the source manifest lifecycle for ignore-scripts package artifacts", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-docker-manifest-source-");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-manifest-output-"));
    const scriptsDir = path.join(sourceDir, "scripts");
    const packageJsonPath = path.join(sourceDir, "package.json");
    const originalPackageJson = `${JSON.stringify(
      {
        devDependencies: {
          "@openclaw/session-url-contract": "workspace:*",
          vitest: "4.1.10",
        },
        name: "openclaw",
        version: "2026.8.1",
      },
      null,
      2,
    )}\n`;
    const aiPackageJsonPath = path.join(sourceDir, "packages", "ai", "package.json");
    const originalAiPackageJson =
      '{"name":"@openclaw/ai","devDependencies":{"@openclaw/normalization-core":"workspace:*"}}\n';
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(path.dirname(aiPackageJsonPath), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "scripts", "package-manifest.mjs"),
      path.join(scriptsDir, "package-manifest.mjs"),
    );
    fs.writeFileSync(packageJsonPath, originalPackageJson);
    fs.writeFileSync(aiPackageJsonPath, originalAiPackageJson);

    try {
      const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipDocsMapLifecycle,
        ...skipTarballModeNormalization,
        prepareBundledAiRuntime: async (_source, _output, _runCapture, options) => {
          const aiDir = path.dirname(aiPackageJsonPath);
          expect(options).toBeDefined();
          await options?.prepareManifest?.(aiDir);
          expect(
            JSON.parse(fs.readFileSync(aiPackageJsonPath, "utf8")).devDependencies,
          ).toBeUndefined();
          await options?.restoreManifest?.(aiDir);
          return async () => {};
        },
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        runCaptureImpl: async () => {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
            devDependencies?: Record<string, string>;
          };
          expect(packageJson.devDependencies).toEqual({ vitest: "4.1.10" });
          expect(fs.readFileSync(aiPackageJsonPath, "utf8")).toBe(originalAiPackageJson);
          const packedPath = path.join(outputDir, "openclaw-2026.8.1.tgz");
          fs.writeFileSync(packedPath, "package");
          return `${path.basename(packedPath)}\n`;
        },
      });

      expect(tarball).toBe(path.join(outputDir, "openclaw-2026.8.1.tgz"));
      expect(fs.readFileSync(packageJsonPath, "utf8")).toBe(originalPackageJson);
      expect(fs.readFileSync(aiPackageJsonPath, "utf8")).toBe(originalAiPackageJson);
      expect(
        fs.existsSync(
          path.join(sourceDir, ".artifacts", "package-manifest", "package.json.prepack-backup"),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("leaves pre-AI-workspace package sources unchanged", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-legacy-source-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-legacy-output-"));
    const packageJsonPath = path.join(sourceDir, "package.json");
    const originalPackageJson = `${JSON.stringify({
      dependencies: { "dep-a": "1.2.3" },
      name: "openclaw",
      version: "2026.7.1",
    })}\n`;
    fs.writeFileSync(packageJsonPath, originalPackageJson);
    const runCapture = vi.fn();

    try {
      const cleanup = await prepareBundledAiRuntimePackage(sourceDir, outputDir, runCapture);

      expect(runCapture).not.toHaveBeenCalled();
      expect(fs.readFileSync(packageJsonPath, "utf8")).toBe(originalPackageJson);
      await cleanup();
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects incomplete AI workspace package sources", async () => {
    const cases = [
      {
        dependencies: { "@openclaw/ai": "workspace:*" },
        expected: "@openclaw/ai dependency requires the packages/ai workspace",
        withWorkspace: false,
      },
      {
        dependencies: {},
        expected: "root package.json must declare @openclaw/ai as a dependency",
        withWorkspace: true,
      },
    ];

    for (const testCase of cases) {
      const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-invalid-source-"));
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-invalid-output-"));
      fs.writeFileSync(
        path.join(sourceDir, "package.json"),
        `${JSON.stringify({ dependencies: testCase.dependencies, name: "openclaw" })}\n`,
      );
      if (testCase.withWorkspace) {
        fs.mkdirSync(path.join(sourceDir, "packages", "ai"), { recursive: true });
        fs.writeFileSync(path.join(sourceDir, "packages", "ai", "package.json"), "{}\n");
      }

      try {
        await expect(prepareBundledAiRuntimePackage(sourceDir, outputDir, vi.fn())).rejects.toThrow(
          testCase.expected,
        );
      } finally {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    }
  });

  it("trims and restores the changelog around ignore-scripts package artifacts", async () => {
    const outputDir = tempDirs.make("openclaw-package-output-");
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const calls: string[] = [];
    const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
      ...skipTarballModeNormalization,
      prepareBundledAiRuntime: skipBundledAiRuntime,
      prepareChangelog: async (cwd: string) => {
        calls.push(`prepare:${cwd}`);
      },
      restoreChangelog: async (cwd: string) => {
        calls.push(`restore-changelog:${cwd}`);
      },
      prepareDocsMap: async (cwd: string) => {
        calls.push(`prepare-docs:${cwd}`);
      },
      restoreDocsMap: async (cwd: string) => {
        calls.push(`restore-docs:${cwd}`);
      },
      runCaptureImpl: async (command: string, args: string[], cwd: string) => {
        calls.push(`${command}:${args.join(" ")}:${cwd}`);
        return "openclaw-2026.5.28.tgz\n";
      },
    });

    expect(tarball).toBe(path.join(outputDir, "openclaw-2026.5.28.tgz"));
    expect(calls).toEqual([
      `prepare-docs:${sourceDir}`,
      `prepare:${sourceDir}`,
      `npm:pack --silent --ignore-scripts --pack-destination ${outputDir} --json=false:${sourceDir}`,
      `restore-changelog:${sourceDir}`,
      `restore-docs:${sourceDir}`,
    ]);
  });

  it("does not touch other source artifacts when the docs-map lock fails", async () => {
    const calls: string[] = [];

    await expect(
      packOpenClawPackageForDocker("/repo", "/out", {
        prepareChangelog: async () => calls.push("prepare-changelog"),
        prepareDocsMap: async () => {
          calls.push("prepare-docs");
          throw new Error("docs failed");
        },
      }),
    ).rejects.toThrow("docs failed");

    expect(calls).toEqual(["prepare-docs"]);
  });

  it.each([false, true])(
    "preserves the next package's marker after a failed=%s owner releases its receipt",
    async (firstFails) => {
      const { sourceDir, outputDir, files } = createSelectedPluginPackageFixture();
      const secondOutput = tempDirs.make("openclaw-next-package-");
      const rejectedOutput = tempDirs.make("openclaw-rejected-package-");
      fs.mkdirSync(path.join(sourceDir, "docs"));
      fs.writeFileSync(path.join(sourceDir, "docs/page.md"), "# Package docs\n");
      const sourceChangelog =
        "# Changelog\n\n## 2026.8.1\n- Current package notes with enough detail.\n";
      fs.writeFileSync(path.join(sourceDir, "CHANGELOG.md"), sourceChangelog);
      await writePackageDistInventoryForPublish(sourceDir);
      const markerPath = path.join(sourceDir, ".openclaw-lifecycle-pending");
      const receiptPath = path.join(sourceDir, ".artifacts/package-docs-map/receipt.json");
      const lifecycle = {
        ...skipTarballModeNormalization,
        prepareDocsMap: preparePackageDocsMap,
        restoreDocsMap: restorePackageDocsMap,
        prepareManifest: preparePackageManifest,
        restoreManifest: restorePackageManifest,
      };
      const ready = createDeferred();
      const finishSecond = createDeferred();
      let second: Promise<string> | undefined;
      let markerAtCapture: string | undefined;
      const firstError = new Error("first pack failed");
      const first = packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...lifecycle,
        runCaptureImpl: async () => {
          const receipt = fs.readFileSync(receiptPath, "utf8");
          const marker = fs.readFileSync(markerPath, "utf8");
          await expect(
            packOpenClawPackageForDocker(sourceDir, rejectedOutput, lifecycle),
          ).rejects.toMatchObject({ code: "PACKAGE_DOCS_MAP_ACTIVE" });
          expect(fs.readFileSync(receiptPath, "utf8")).toBe(receipt);
          expect(fs.readFileSync(markerPath, "utf8")).toBe(marker);
          if (firstFails) {
            throw firstError;
          }
          fs.writeFileSync(path.join(outputDir, "openclaw-2026.8.1.tgz"), "package");
          return "openclaw-2026.8.1.tgz\n";
        },
        restoreDocsMap: async (cwd) => {
          await restorePackageDocsMap(cwd);
          second = packOpenClawPackageForDocker(sourceDir, secondOutput, {
            ...lifecycle,
            runCaptureImpl: async () => {
              markerAtCapture = fs.readFileSync(markerPath, "utf8");
              ready.resolve();
              await finishSecond.promise;
              fs.writeFileSync(path.join(secondOutput, "openclaw-2026.8.1.tgz"), "package");
              return "openclaw-2026.8.1.tgz\n";
            },
          });
          void second.catch(ready.reject);
          await ready.promise;
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      let markerAfterFirst: string | undefined;
      const firstResult = await first;
      try {
        markerAfterFirst = fs.existsSync(markerPath)
          ? fs.readFileSync(markerPath, "utf8")
          : undefined;
      } finally {
        finishSecond.resolve();
        await second;
      }
      expect(firstResult).toBe(firstFails ? firstError : undefined);
      expect(second).toBeDefined();
      expect(markerAtCapture).toBe("pending\n");
      expect(markerAfterFirst).toBe("pending\n");
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(receiptPath)).toBe(false);
      expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(
        files["package.json"],
      );
      expect(fs.readFileSync(path.join(sourceDir, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
    },
  );

  it("keeps the docs-map lock when changelog restoration fails", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const outputDir = tempDirs.make("openclaw-package-restore-order-");
    const calls: string[] = [];

    await expect(
      packOpenClawPackageForDocker(sourceDir, outputDir, {
        prepareBundledAiRuntime: skipBundledAiRuntime,
        prepareChangelog: async () => {},
        prepareDocsMap: async () => {},
        restoreChangelog: async () => {
          calls.push("restore-changelog");
          throw new Error("changelog restore failed");
        },
        restoreDocsMap: async () => {
          calls.push("restore-docs");
        },
        runCaptureImpl: async () => {
          const packedPath = path.join(outputDir, "openclaw-2026.8.1.tgz");
          fs.writeFileSync(packedPath, "package");
          return `${path.basename(packedPath)}\n`;
        },
      }),
    ).rejects.toThrow("changelog restore failed");

    expect(calls).toEqual(["restore-changelog"]);
  });

  it("packages Unreleased notes for explicitly non-publish stable artifacts", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-unreleased-package-");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreleased-output-"));
    const sourceChangelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "### Fixes",
      "- Pending release notes with enough detail.",
      "",
      "## 2026.5.28",
      "- Previous release notes with enough detail.",
      "",
    ].join("\n");
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      '{"name":"openclaw","version":"2026.5.29"}\n',
    );
    fs.writeFileSync(path.join(sourceDir, "CHANGELOG.md"), sourceChangelog);
    fs.mkdirSync(path.join(sourceDir, "docs"));
    fs.writeFileSync(path.join(sourceDir, "docs", "page.md"), "# Package page\n");
    fs.mkdirSync(path.join(sourceDir, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "scripts", "package-docs-map.mjs"),
      path.join(sourceDir, "scripts", "package-docs-map.mjs"),
    );
    fs.copyFileSync(
      path.join(process.cwd(), "scripts", "docs-list.js"),
      path.join(sourceDir, "scripts", "docs-list.js"),
    );

    try {
      const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipTarballModeNormalization,
        allowUnreleasedChangelog: true,
        prepareBundledAiRuntime: skipBundledAiRuntime,
        runCaptureImpl: async () => {
          const packagedChangelog = fs.readFileSync(path.join(sourceDir, "CHANGELOG.md"), "utf8");
          expect(packagedChangelog).toContain("## Unreleased");
          expect(packagedChangelog).not.toContain("## 2026.5.28");
          expect(fs.readFileSync(path.join(sourceDir, "docs", "docs_map.md"), "utf8")).toContain(
            "## page.md",
          );
          const packedPath = path.join(outputDir, "openclaw-2026.5.29.tgz");
          fs.writeFileSync(packedPath, "package");
          return "openclaw-2026.5.29.tgz\n";
        },
      });

      expect(tarball).toBe(path.join(outputDir, "openclaw-2026.5.29.tgz"));
      expect(fs.readFileSync(path.join(sourceDir, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
      expect(fs.existsSync(path.join(sourceDir, "docs", "docs_map.md"))).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the docs surface of a pre-map source package unchanged", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-frozen-package-");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-frozen-output-"));
    const docsDir = path.join(sourceDir, "docs");
    fs.mkdirSync(docsDir);
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      '{"name":"openclaw","version":"2026.6.33"}\n',
    );
    fs.writeFileSync(
      path.join(docsDir, "index.md"),
      '---\nsummary: "Frozen OpenClaw docs"\n---\n\n# OpenClaw\n',
    );
    expect(fs.existsSync(path.join(sourceDir, "scripts", "package-docs-map.mjs"))).toBe(false);

    try {
      const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipTarballModeNormalization,
        prepareBundledAiRuntime: skipBundledAiRuntime,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        runCaptureImpl: async () => {
          expect(fs.existsSync(path.join(docsDir, "docs_map.md"))).toBe(false);
          const packedPath = path.join(outputDir, "openclaw-2026.6.33.tgz");
          fs.writeFileSync(packedPath, "frozen package");
          return `${path.basename(packedPath)}\n`;
        },
      });

      expect(tarball).toBe(path.join(outputDir, "openclaw-2026.6.33.tgz"));
      expect(fs.existsSync(path.join(docsDir, "docs_map.md"))).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("packs the bundled AI runtime with isolated workspace configuration", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-pnpm-bundled-source-");
    const outputDir = tempDirs.make("openclaw-pnpm-bundled-output-");
    const { packageManager, version } = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      packageManager: string;
      version: string;
    };
    const packageJson = JSON.stringify({
      name: "openclaw",
      version,
      packageManager,
      files: ["dist"],
      dependencies: { "@openclaw/ai": "workspace:*" },
      scripts: { prepack: 'node -e "process.exit(91)"' },
    });
    const workspace = "packages:\n  - packages/*\nnodeLinker: isolated\n";
    const aiDir = path.join(sourceDir, "packages/ai");
    const installedAi = path.join(sourceDir, "node_modules/@openclaw/ai");
    fs.mkdirSync(path.join(sourceDir, "dist"));
    fs.mkdirSync(path.join(aiDir, "dist"), { recursive: true });
    fs.mkdirSync(path.dirname(installedAi), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "package.json"), packageJson);
    fs.writeFileSync(path.join(sourceDir, "pnpm-workspace.yaml"), workspace);
    fs.writeFileSync(path.join(sourceDir, "dist/entry.js"), "export const worker = true;\n");
    fs.writeFileSync(
      path.join(aiDir, "package.json"),
      JSON.stringify({ name: "@openclaw/ai", version, files: ["dist"] }),
    );
    fs.writeFileSync(path.join(aiDir, "dist/index.js"), "export const runtime = true;\n");
    fs.writeFileSync(path.join(aiDir, "source-only-marker"), "workspace source\n");
    fs.symlinkSync(aiDir, installedAi, "junction");

    const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
      ...skipDocsMapLifecycle,
      pnpmPack: true,
      prepareChangelog: async () => {},
      restoreChangelog: async () => {},
    });
    const extracted = tempDirs.make("openclaw-pnpm-bundled-extracted-");
    await tar.x({ file: tarball, cwd: extracted });
    const packedRoot = path.join(extracted, "package");
    expect(fs.readFileSync(path.join(packedRoot, "dist/entry.js"), "utf8")).toBe(
      "export const worker = true;\n",
    );
    expect(
      fs.readFileSync(path.join(packedRoot, "node_modules/@openclaw/ai/dist/index.js"), "utf8"),
    ).toBe("export const runtime = true;\n");
    expect(
      JSON.parse(fs.readFileSync(path.join(packedRoot, "package.json"), "utf8")),
    ).toMatchObject({
      dependencies: { "@openclaw/ai": version },
      bundleDependencies: ["@openclaw/ai"],
    });
    expect(
      fs.existsSync(path.join(packedRoot, "node_modules/@openclaw/ai/source-only-marker")),
    ).toBe(false);
    expect(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")).toBe(packageJson);
    expect(fs.readFileSync(path.join(sourceDir, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);
    expect(fs.lstatSync(installedAi).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(installedAi, "source-only-marker"), "utf8")).toBe(
      "workspace source\n",
    );
    expect(fs.readdirSync(outputDir)).toEqual([path.basename(tarball)]);
  });

  it("normalizes npm 12 pack metadata for renamed package artifacts", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-docker-pack-source-");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-pack-json-"));
    const packJsonPath = path.join(outputDir, "pack.json");
    const npmPackOutput = JSON.stringify({
      openclaw: {
        entryCount: 15_000,
        filename: "openclaw-2026.5.28.tgz",
        files: Array.from({ length: 15_000 }, (_, index) => ({
          mode: 0o644,
          path: `dist/generated/package-entry-${String(index).padStart(5, "0")}.js`,
          size: index,
        })),
        size: 7,
        unpackedSize: 7,
        version: "2026.5.28",
      },
    });
    expect(Buffer.byteLength(npmPackOutput)).toBeGreaterThan(1024 * 1024);
    const npmPackOutputPath = path.join(sourceDir, "npm-pack.json");
    fs.writeFileSync(npmPackOutputPath, npmPackOutput);

    try {
      const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipDocsMapLifecycle,
        ...skipTarballModeNormalization,
        outputName: "openclaw-current.tgz",
        packJsonPath,
        prepareBundledAiRuntime: skipBundledAiRuntime,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        runCaptureImpl: async (_command, _args, cwd, options) => {
          if (!options.stdoutFilePath) {
            fs.writeFileSync(path.join(outputDir, "openclaw-2026.5.28.tgz"), "package");
            return "openclaw-2026.5.28.tgz\n";
          }
          return await runCaptureForTest(
            process.execPath,
            [
              "-e",
              "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",
              npmPackOutputPath,
            ],
            cwd,
            options,
          );
        },
      });

      expect(tarball).toBe(path.join(outputDir, "openclaw-current.tgz"));
      const packJson = JSON.parse(fs.readFileSync(packJsonPath, "utf8")) as Array<{
        entryCount: number;
        filename: string;
        files: unknown[];
      }>;
      expect(packJson).toHaveLength(1);
      expect(packJson[0]).toMatchObject({
        entryCount: 15_000,
        filename: "openclaw-current.tgz",
      });
      expect(packJson[0]?.files).toHaveLength(15_000);
    } finally {
      fs.rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("cleans receipts without obscuring runner and parse failures", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const originalRm = fs.promises.rm.bind(fs.promises);
    for (const failure of ["runner", "parse"] as const) {
      for (const cleanupFails of [false, true]) {
        const outputDir = tempDirs.make(`openclaw-docker-pack-${failure}-`);
        const cleanupError = new Error("receipt cleanup failed");
        let receiptPath = "";
        const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
          if (cleanupFails && receiptPath && target === path.dirname(receiptPath)) {
            throw cleanupError;
          }
          return await originalRm(target, options);
        });
        try {
          const packPromise = packOpenClawPackageForDocker(sourceDir, outputDir, {
            ...skipDocsMapLifecycle,
            ...skipTarballModeNormalization,
            packJsonPath: path.join(outputDir, "pack.json"),
            prepareBundledAiRuntime: skipBundledAiRuntime,
            prepareChangelog: async () => {},
            restoreChangelog: async () => {},
            runCaptureImpl: async (_command, _args, _cwd, options) => {
              if (!options.stdoutFilePath) {
                fs.writeFileSync(path.join(outputDir, "openclaw-2026.5.28.tgz"), "package");
                return "openclaw-2026.5.28.tgz\n";
              }
              receiptPath = options.stdoutFilePath ?? "";
              if (failure === "runner") {
                throw new Error("npm pack failed");
              }
              fs.writeFileSync(receiptPath, "not json");
              return "";
            },
          });
          const message =
            failure === "runner" ? "npm pack failed" : "npm pack --json output was not valid JSON";
          if (cleanupFails) {
            await expect(packPromise).rejects.toMatchObject({
              cause: expect.objectContaining({ message }),
              errors: [expect.objectContaining({ message }), cleanupError],
              message: "Package operation and cleanup both failed.",
            });
          } else {
            await expect(packPromise).rejects.toThrow(message);
            expect(fs.existsSync(receiptPath)).toBe(false);
          }
          expect(receiptPath).not.toBe("");
        } finally {
          rmSpy.mockRestore();
          if (receiptPath) {
            fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
          }
        }
      }
    }
  });

  it("rejects path-like npm pack stdout before resolving Docker package tarballs", async () => {
    const outputDir = tempDirs.make("openclaw-package-output-");
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    for (const filename of [
      "../openclaw-2026.6.17.tgz",
      "/tmp/openclaw-2026.6.17.tgz",
      String.raw`C:\temp\openclaw-2026.6.17.tgz`,
      "openclaw-nested/evil.tgz",
      String.raw`openclaw-nested\evil.tgz`,
      "openclaw-C:evil.tgz",
    ]) {
      await expect(
        packOpenClawPackageForDocker(sourceDir, outputDir, {
          ...skipDocsMapLifecycle,
          prepareBundledAiRuntime: skipBundledAiRuntime,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
          runCaptureImpl: async () => `${filename}\n`,
        }),
      ).rejects.toThrow("npm pack reported unsafe OpenClaw tarball filename");
    }
  });

  it("ignores unsafe output directory tarball names when npm stdout is not usable", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-pack-"));
    try {
      if (process.platform === "win32") {
        const nestedDir = path.join(outputDir, "openclaw-nested");
        fs.mkdirSync(nestedDir);
        fs.writeFileSync(path.join(nestedDir, "evil.tgz"), "");
      } else {
        fs.writeFileSync(path.join(outputDir, "openclaw-C:evil.tgz"), "");
        fs.writeFileSync(path.join(outputDir, String.raw`openclaw-nested\evil.tgz`), "");
      }
      await expect(
        packOpenClawPackageForDocker(sourceDir, outputDir, {
          ...skipDocsMapLifecycle,
          prepareBundledAiRuntime: skipBundledAiRuntime,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
          runCaptureImpl: async () => "npm notice\n",
        }),
      ).rejects.toThrow("missing packed OpenClaw tarball");

      await expect(
        packOpenClawPackageForDocker(sourceDir, outputDir, {
          ...skipDocsMapLifecycle,
          ...skipTarballModeNormalization,
          prepareBundledAiRuntime: skipBundledAiRuntime,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
          runCaptureImpl: async () => {
            fs.writeFileSync(path.join(outputDir, "openclaw-2026.6.17.tgz"), "");
            return "npm notice\n";
          },
        }),
      ).resolves.toBe(path.join(outputDir, "openclaw-2026.6.17.tgz"));
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("ignores stale package tarballs before fallback scanning npm output", async () => {
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-pack-stale-"));
    try {
      fs.writeFileSync(path.join(outputDir, "openclaw-9999.1.1.tgz"), "stale");

      await expect(
        packOpenClawPackageForDocker(sourceDir, outputDir, {
          ...skipDocsMapLifecycle,
          ...skipTarballModeNormalization,
          prepareBundledAiRuntime: skipBundledAiRuntime,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
          runCaptureImpl: async () => {
            fs.writeFileSync(path.join(outputDir, "openclaw-2026.6.17.tgz"), "current");
            return "npm notice\n";
          },
        }),
      ).resolves.toBe(path.join(outputDir, "openclaw-2026.6.17.tgz"));

      expect(fs.existsSync(path.join(outputDir, "openclaw-9999.1.1.tgz"))).toBe(false);
      expect(fs.readFileSync(path.join(outputDir, "openclaw-2026.6.17.tgz"), "utf8")).toBe(
        "current",
      );
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("restores the changelog when ignore-scripts packaging fails", async () => {
    const outputDir = tempDirs.make("openclaw-package-output-");
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const calls: string[] = [];

    await expect(
      packOpenClawPackageForDocker(sourceDir, outputDir, {
        ...skipDocsMapLifecycle,
        prepareBundledAiRuntime: async () => {
          calls.push("embed");
          return async () => {
            calls.push("cleanup");
          };
        },
        prepareChangelog: async (cwd: string) => {
          calls.push(`prepare:${cwd}`);
        },
        restoreChangelog: async (cwd: string) => {
          calls.push(`restore-changelog:${cwd}`);
        },
        runCaptureImpl: async () => {
          calls.push("pack");
          throw new Error("pack failed");
        },
      }),
    ).rejects.toThrow("pack failed");

    expect(calls).toEqual([
      `prepare:${sourceDir}`,
      "embed",
      "pack",
      "cleanup",
      `restore-changelog:${sourceDir}`,
    ]);
  });

  it("clamps oversized command timers before scheduling", async () => {
    await expect(
      runCommandForTest(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(0), 25);"],
        process.cwd(),
        {
          killAfterMs: MAX_TIMER_TIMEOUT_MS + 1,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
      ),
    ).resolves.toBe("");
  });

  it("kills timed-out child process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-timeout-"));
    const childPidPath = path.join(tempDir, "child.pid");
    let childPid = 0;
    try {
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(process.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "setInterval(() => {}, 1000);",
      ].join("");

      await expectCommandTimeoutAfterReady(
        () =>
          runCommandForTest(process.execPath, ["-e", parentScript], process.cwd(), {
            env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            killAfterMs: 25,
            timeoutMs: 500,
          }),
        async () => {
          childPid = await readPid(childPidPath, 2000);
        },
      );
      await waitForDead(childPid, 2000);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("clamps oversized kill grace before scheduling", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-grace-"));
    const donePath = path.join(tempDir, "done");
    const childPidPath = path.join(tempDir, "child.pid");
    let childPid = 0;
    try {
      const script = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
        "});",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expectCommandTimeoutAfterReady(
        () =>
          runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
            killAfterMs: MAX_TIMER_TIMEOUT_MS + 1,
            timeoutMs: 500,
          }),
        async () => {
          childPid = await readPid(childPidPath, 2000);
        },
      );
      expect(fs.readFileSync(donePath, "utf8")).toBe("done");
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps fallback SIGKILL armed for descendants after the direct child exits", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-descendant-"));
    const childPidPath = path.join(tempDir, "child.pid");
    let childPid = 0;
    try {
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(process.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "setInterval(() => {}, 1000);",
      ].join("");

      await expectCommandTimeoutAfterReady(
        () =>
          runCommandForTest(process.execPath, ["-e", parentScript], process.cwd(), {
            env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            killAfterMs: 25,
            timeoutMs: 500,
          }),
        async () => {
          childPid = await readPid(childPidPath, 2000);
        },
      );
      await waitForDead(childPid, 2000);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("does not fire delayed SIGKILL after a timed-out child exits during grace", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = tempDirs.make("openclaw-package-grace-exit-");
    const childPidPath = path.join(tempDir, "child.pid");
    let childPid = 0;
    const killSpy = vi.spyOn(process, "kill");
    try {
      const script = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => process.exit(0));",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");

      await expectCommandTimeoutAfterReady(
        () =>
          runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
            killAfterMs: 100,
            timeoutMs: 25,
          }),
        async () => {
          childPid = await readPid(childPidPath, 2000);
        },
        25,
      );

      const sigkillCallsAfterExit = killSpy.mock.calls.filter(
        ([, signal]) => signal === "SIGKILL",
      ).length;
      await sleep(150);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(
        sigkillCallsAfterExit,
      );
    } finally {
      killSpy.mockRestore();
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  it("fails captured commands that exceed the stdout limit", async () => {
    const script = [
      "process.stdout.write('x'.repeat(2048));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");

    await expect(
      runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
        captureStdout: true,
        killAfterMs: 50,
        maxCapturedStdoutBytes: 1024,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exceeded captured stdout limit \(1024 bytes\)/u);
  });

  it("writes exact stdout bytes to a file and rejects capture conflicts", async () => {
    const tempDir = tempDirs.make("openclaw-package-stdout-file-");
    const stdoutFilePath = path.join(tempDir, "stdout.bin");
    const expected = Buffer.from([0, 1, 10, 13, 127, 128, 255]);
    const output = await runCommandForTest(
      process.execPath,
      ["-e", `process.stdout.write(Buffer.from(${JSON.stringify([...expected])}))`],
      process.cwd(),
      { stdoutFilePath },
    );

    expect(output).toBe("");
    expect(fs.readFileSync(stdoutFilePath)).toEqual(expected);
    await expect(
      runCommandForTest(process.execPath, ["-e", ""], process.cwd(), {
        captureStdout: true,
        stdoutFilePath: path.join(tempDir, "conflict.bin"),
      }),
    ).rejects.toThrow("captureStdout and stdoutFilePath cannot be combined");
  });

  it("restores source artifacts before exiting after receipt-read termination", async () => {
    if (process.platform === "win32") {
      return;
    }
    const sourceDir = createPackageSourceFixture("openclaw-package-source-");
    const tempDir = tempDirs.make("openclaw-package-receipt-signal-");
    const markerPath = path.join(tempDir, "restored");
    const scriptUrl = pathToFileURL(path.resolve("scripts/package-openclaw-for-docker.mts")).href;
    const runnerScript = `
import fs from "node:fs";
const readFile = fs.promises.readFile.bind(fs.promises);
fs.promises.readFile = async (...args) => { if (String(args[0]).endsWith("/pack.json")) { process.kill(process.pid, "SIGTERM"); await new Promise((resolve) => setTimeout(resolve, 50)); } return await readFile(...args); };
const { packOpenClawPackageForDocker } = await import(${JSON.stringify(scriptUrl)});
try {
  await packOpenClawPackageForDocker(${JSON.stringify(sourceDir)}, ${JSON.stringify(tempDir)}, { packJsonPath: "result.json", normalizeTarballModes: async () => {}, prepareBundledAiRuntime: async () => async () => {}, prepareChangelog: async () => {}, prepareDocsMap: async () => {}, prepareManifest: async () => {}, restoreChangelog: async () => {}, restoreDocsMap: async () => { fs.writeFileSync(${JSON.stringify(markerPath)}, "done"); }, restoreManifest: async () => {}, runCaptureImpl: async (_command, _args, _cwd, options) => { if (options.stdoutFilePath) fs.writeFileSync(options.stdoutFilePath, '[{"filename":"openclaw-2026.5.28.tgz"}]'); fs.writeFileSync(${JSON.stringify(path.join(tempDir, "openclaw-2026.5.28.tgz"))}, "package"); return "openclaw-2026.5.28.tgz\\n"; } });
} catch (error) { process.exit(error.exitCode ?? 1); }
`;
    const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript]);
    expect(await waitForExit(runner, 5000)).toEqual({ signal: null, status: 143 });
    expect(fs.readFileSync(markerPath, "utf8")).toBe("done");
  });

  it("forwards external termination to active child process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-signal-"));
    const childPidPath = path.join(tempDir, "child.pid");
    const scriptUrl = pathToFileURL(path.resolve("scripts/package-openclaw-for-docker.mts")).href;
    let childPid = 0;
    let runnerPid;
    try {
      const childScript = "setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const runnerScript = [
        `import { runCommandForTest } from ${JSON.stringify(scriptUrl)};`,
        `await runCommandForTest(process.execPath, ['-e', ${JSON.stringify(parentScript)}], process.cwd(), { timeoutMs: 60000 });`,
      ].join("\n");
      const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
        stdio: ["ignore", "ignore", "pipe"],
      });
      runnerPid = runner.pid ?? 0;

      childPid = await readPid(childPidPath, 2000);
      runner.kill("SIGTERM");
      const result = await waitForExit(runner, 5000);

      expect(result).toEqual({ signal: null, status: 143 });
      await waitForDead(childPid, 2000);
    } finally {
      if (runnerPid && isProcessAlive(runnerPid)) {
        process.kill(runnerPid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
