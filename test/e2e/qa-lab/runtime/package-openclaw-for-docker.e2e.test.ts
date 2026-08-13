// Package OpenClaw For Docker tests cover QA Lab package artifact evidence.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "../../../../scripts/lib/bundled-plugin-build-entries.mjs";
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
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const skipBundledAiRuntime = async (): Promise<() => Promise<void>> => async () => {};
const skipDocsMapLifecycle = {
  prepareDocsMap: async (): Promise<void> => {},
  restoreDocsMap: async (): Promise<void> => {},
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tsxImport = import.meta.resolve("tsx");

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
    async () => {
      const tempDir = tempDirs.make("openclaw-package-pnpm-timeout-");
      const childPidPath = path.join(tempDir, "child.pid");
      const childScriptPath = path.join(tempDir, "child.cjs");
      fs.writeFileSync(
        childScriptPath,
        [
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(process.pid));",
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
      try {
        const runPromise = runCommandForTest("pnpm", ["probe"], tempDir, {
          env,
          killAfterMs: 25,
          timeoutMs: 500,
        });
        childPid = await readPid(childPidPath, 2_000);
        await expect(runPromise).rejects.toThrow(/timed out after 500ms/u);
        await waitForDead(childPid, 2_000);
      } finally {
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
      outputDir: ".artifacts/docker",
      outputName: "openclaw-current.tgz",
      packJson: ".artifacts/docker/pack.json",
      pnpmPack: false,
      skipBuild: true,
      sourceDir: "/repo",
    });
  });

  it("rejects missing package artifact option values", () => {
    for (const flag of ["--output-dir", "--output-name", "--source-dir"]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--skip-build"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([`${flag}=`])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([`${flag}=-h`])).toThrow(`${flag} requires a value`);
    }
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
      "scripts/docs-list.js",
      "scripts/npm-runner.mts",
      "scripts/pnpm-runner.mts",
      "scripts/windows-cmd-helpers.mjs",
      "scripts/lib/bundled-plugin-build-entries.mjs",
      "scripts/lib/bundled-plugin-paths.mjs",
      "scripts/lib/error-format.mts",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/npm-json-output.mts",
      "scripts/lib/optional-bundled-clusters.mjs",
      "scripts/lib/record-shared.mjs",
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
        fs.writeFileSync(
          path.join(sourceDir, "dist", "postinstall-inventory.json"),
          JSON.stringify(["dist/entry.js"]),
        );
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
      await buildPackageArtifacts("/repo", {
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
        cwd: "/repo",
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
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-manifest-source-"));
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
    fs.mkdirSync(scriptsDir);
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
    const calls: string[] = [];
    const tarball = await packOpenClawPackageForDocker("/repo", "/out", {
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

    expect(tarball).toBe(path.join("/out", "openclaw-2026.5.28.tgz"));
    expect(calls).toEqual([
      "prepare-docs:/repo",
      "prepare:/repo",
      "npm:pack --silent --ignore-scripts --pack-destination /out:/repo",
      "restore-changelog:/repo",
      "restore-docs:/repo",
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

  it("keeps the docs-map lock when changelog restoration fails", async () => {
    const outputDir = tempDirs.make("openclaw-package-restore-order-");
    const calls: string[] = [];

    await expect(
      packOpenClawPackageForDocker("/repo", outputDir, {
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
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreleased-package-"));
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
    fs.mkdirSync(path.join(sourceDir, "scripts"));
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

  it("keeps a frozen pre-map source package byte-owned by that ref", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-frozen-package-"));
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

  it("uses pnpm pack when requested", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-pack-"));
    const calls: string[] = [];
    const packedPath = path.join(outputDir, "openclaw-2026.5.28.tgz");

    try {
      const tarball = await packOpenClawPackageForDocker("/repo", outputDir, {
        ...skipDocsMapLifecycle,
        pnpmPack: true,
        prepareBundledAiRuntime: skipBundledAiRuntime,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        runCaptureImpl: async (command: string, args: string[], cwd: string) => {
          calls.push(`${command}:${args.join(" ")}:${cwd}`);
          fs.writeFileSync(packedPath, "package");
          return `${packedPath}\n`;
        },
      });

      expect(tarball).toBe(packedPath);
      expect(calls).toEqual([
        `pnpm:pack --silent --config.ignore-scripts=true --pack-destination ${outputDir}:/repo`,
      ]);
    } finally {
      fs.rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("normalizes npm 12 pack metadata for renamed package artifacts", async () => {
    const sourceDir = tempDirs.make("openclaw-docker-pack-source-");
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
        outputName: "openclaw-current.tgz",
        packJsonPath,
        prepareBundledAiRuntime: skipBundledAiRuntime,
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        runCaptureImpl: async (_command, _args, cwd, options) => {
          fs.writeFileSync(path.join(outputDir, "openclaw-2026.5.28.tgz"), "package");
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
          const packPromise = packOpenClawPackageForDocker("/repo", outputDir, {
            ...skipDocsMapLifecycle,
            packJsonPath: path.join(outputDir, "pack.json"),
            prepareBundledAiRuntime: skipBundledAiRuntime,
            prepareChangelog: async () => {},
            restoreChangelog: async () => {},
            runCaptureImpl: async (_command, _args, _cwd, options) => {
              receiptPath = options.stdoutFilePath ?? "";
              if (failure === "runner") throw new Error("npm pack failed");
              fs.writeFileSync(receiptPath, "not json");
              fs.writeFileSync(path.join(outputDir, "openclaw-2026.5.28.tgz"), "package");
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
          if (receiptPath) fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
        }
      }
    }
  });

  it("rejects path-like npm pack stdout before resolving Docker package tarballs", async () => {
    for (const filename of [
      "../openclaw-2026.6.17.tgz",
      "/tmp/openclaw-2026.6.17.tgz",
      String.raw`C:\temp\openclaw-2026.6.17.tgz`,
      "openclaw-nested/evil.tgz",
      String.raw`openclaw-nested\evil.tgz`,
      "openclaw-C:evil.tgz",
    ]) {
      await expect(
        packOpenClawPackageForDocker("/repo", "/out", {
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
        packOpenClawPackageForDocker("/repo", outputDir, {
          ...skipDocsMapLifecycle,
          prepareBundledAiRuntime: skipBundledAiRuntime,
          prepareChangelog: async () => {},
          restoreChangelog: async () => {},
          runCaptureImpl: async () => "npm notice\n",
        }),
      ).rejects.toThrow("missing packed OpenClaw tarball");

      await expect(
        packOpenClawPackageForDocker("/repo", outputDir, {
          ...skipDocsMapLifecycle,
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
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-pack-stale-"));
    try {
      fs.writeFileSync(path.join(outputDir, "openclaw-9999.1.1.tgz"), "stale");

      await expect(
        packOpenClawPackageForDocker("/repo", outputDir, {
          ...skipDocsMapLifecycle,
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
    const calls: string[] = [];

    await expect(
      packOpenClawPackageForDocker("/repo", "/out", {
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

    expect(calls).toEqual(["prepare:/repo", "embed", "pack", "cleanup", "restore-changelog:/repo"]);
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
    let childPid;
    try {
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("");

      const runPromise = runCommandForTest(process.execPath, ["-e", parentScript], process.cwd(), {
        env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
        killAfterMs: 25,
        timeoutMs: 500,
      });
      const timeoutAssertion = expect(runPromise).rejects.toThrow(/timed out after 500ms/u);
      childPid = await readPid(childPidPath, 2000);
      await timeoutAssertion;
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
    let childPid;
    try {
      const script = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const runPromise = runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
        killAfterMs: MAX_TIMER_TIMEOUT_MS + 1,
        timeoutMs: 500,
      });
      childPid = await readPid(childPidPath, 2000);

      await expect(runPromise).rejects.toThrow(/timed out after 500ms/u);
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
    let childPid;
    try {
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");

      await expect(
        runCommandForTest(process.execPath, ["-e", parentScript], process.cwd(), {
          env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
          killAfterMs: 25,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/u);

      childPid = await readPid(childPidPath, 2000);
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

    const killSpy = vi.spyOn(process, "kill");
    try {
      const script = [
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");

      await expect(
        runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
          killAfterMs: 100,
          timeoutMs: 25,
        }),
      ).rejects.toThrow(/timed out after 25ms/u);

      const sigkillCallsAfterExit = killSpy.mock.calls.filter(
        ([, signal]) => signal === "SIGKILL",
      ).length;
      await sleep(150);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(
        sigkillCallsAfterExit,
      );
    } finally {
      killSpy.mockRestore();
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
    if (process.platform === "win32") return;
    const tempDir = tempDirs.make("openclaw-package-receipt-signal-");
    const markerPath = path.join(tempDir, "restored");
    const scriptUrl = pathToFileURL(path.resolve("scripts/package-openclaw-for-docker.mts")).href;
    const runnerScript = `
import fs from "node:fs";
const readFile = fs.promises.readFile.bind(fs.promises);
fs.promises.readFile = async (...args) => { if (String(args[0]).endsWith("/pack.json")) { process.kill(process.pid, "SIGTERM"); await new Promise((resolve) => setTimeout(resolve, 50)); } return await readFile(...args); };
const { packOpenClawPackageForDocker } = await import(${JSON.stringify(scriptUrl)});
try {
  await packOpenClawPackageForDocker("/repo", ${JSON.stringify(tempDir)}, { packJsonPath: "result.json", prepareBundledAiRuntime: async () => async () => {}, prepareChangelog: async () => {}, prepareDocsMap: async () => {}, prepareManifest: async () => {}, restoreChangelog: async () => {}, restoreDocsMap: async () => { fs.writeFileSync(${JSON.stringify(markerPath)}, "done"); }, restoreManifest: async () => {}, runCaptureImpl: async (_command, _args, _cwd, options) => { fs.writeFileSync(options.stdoutFilePath, '[{"filename":"openclaw-2026.5.28.tgz"}]'); fs.writeFileSync(${JSON.stringify(path.join(tempDir, "openclaw-2026.5.28.tgz"))}, "package"); return ""; } });
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
