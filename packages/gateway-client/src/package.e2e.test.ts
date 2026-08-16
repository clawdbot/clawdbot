import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import { resolvePnpmRunner } from "../../../scripts/pnpm-runner.mts";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

type CommandResult = { stdout: string; stderr: string };
type PackageManifest = {
  name: string;
  exports: Record<string, unknown>;
};

const COMMAND_TIMEOUT_MS = 180_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number } & Pick<
    SpawnOptionsWithoutStdio,
    "env" | "shell" | "windowsVerbatimArguments"
  >,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error(`command timed out: ${[command, ...args].join(" ")}`));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `command failed (${String(code ?? signal)}): ${[command, ...args].join(" ")}\n` +
              `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          ),
        );
      }
    });
  });
}

function runNpmCommand(args: string[], cwd: string): Promise<CommandResult> {
  const env = {
    ...process.env,
    CI: process.env.CI ?? "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const runner = resolveNpmRunner({ env, npmArgs: args });
  return runCommand(runner.command, runner.args, {
    cwd,
    env: runner.env ?? env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

function runPnpmCommand(args: string[], cwd: string): Promise<CommandResult> {
  const env = {
    ...process.env,
    CI: process.env.CI ?? "true",
  };
  const runner = resolvePnpmRunner({ cwd, env, pnpmArgs: args });
  return runCommand(runner.command, runner.args, {
    cwd,
    env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

async function packPackage(packageRoot: string, destination: string): Promise<string> {
  const result = await runPnpmCommand(
    ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", destination],
    packageRoot,
  );
  const pack = JSON.parse(result.stdout) as { filename?: string };
  const tarball = path.resolve(packageRoot, pack.filename ?? "");
  await fs.stat(tarball);
  return tarball;
}

function packageSpecifier(packageName: string, exportKey: string): string {
  return exportKey === "." ? packageName : `${packageName}/${exportKey.slice(2)}`;
}

describe("@openclaw/gateway-client packed package", () => {
  it("installs cleanly and preserves Node, type, and browser-safe model entrypoints", async () => {
    const repoRoot = process.cwd();
    const clientRoot = path.join(repoRoot, "packages", "gateway-client");
    const protocolRoot = path.join(repoRoot, "packages", "gateway-protocol");
    const manifest = JSON.parse(
      await fs.readFile(path.join(clientRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const nodeTypesVersion = rootManifest.devDependencies?.["@types/node"];
    if (!nodeTypesVersion) {
      throw new Error("root package is missing the @types/node version used by package checks");
    }
    const tempDir = tempDirs.make("openclaw-gateway-client-consumer-");
    await runPnpmCommand(["build"], protocolRoot);
    await runPnpmCommand(["build"], clientRoot);
    const protocolTarball = await packPackage(protocolRoot, tempDir);
    const clientTarball = await packPackage(clientRoot, tempDir);

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await runNpmCommand(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        protocolTarball,
        clientTarball,
        `@types/node@${nodeTypesVersion}`,
      ],
      tempDir,
    );

    const specifiers = Object.keys(manifest.exports).map((key) =>
      packageSpecifier(manifest.name, key),
    );
    await runCommand(
      process.execPath,
      createNodeEvalArgs(
        `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)));`,
        { evalFlag: "-e" },
      ),
      { cwd: tempDir },
    );

    await fs.writeFile(
      path.join(tempDir, "consumer.ts"),
      [
        'import { createControlModel } from "@openclaw/gateway-client/model";',
        'import { createControlModelCatalog } from "@openclaw/gateway-client/model/catalog";',
        'import { createSessionEventRefreshCoordinator } from "@openclaw/gateway-client/model/session-event-refresh";',
        'import type { ControlModelGatewayBinding } from "@openclaw/gateway-client/model";',
        "export type Binding = ControlModelGatewayBinding;",
        "export const values = [",
        "  createControlModel,",
        "  createControlModelCatalog,",
        "  createSessionEventRefreshCoordinator,",
        "];",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2023",
          types: ["node"],
        },
        files: ["consumer.ts"],
      }),
    );
    await runCommand(
      process.execPath,
      ["scripts/run-tsgo.mjs", "-p", path.join(tempDir, "tsconfig.json")],
      {
        cwd: repoRoot,
        env: { ...process.env, OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
      },
    );

    await build({
      absWorkingDir: tempDir,
      bundle: true,
      entryPoints: [path.join(tempDir, "consumer.ts")],
      format: "esm",
      logLevel: "silent",
      outfile: path.join(tempDir, "browser-bundle.mjs"),
      platform: "browser",
      target: "es2023",
    });
    await fs.stat(path.join(tempDir, "browser-bundle.mjs"));

    expect(specifiers).toHaveLength(Object.keys(manifest.exports).length);
  }, 300_000);
});
