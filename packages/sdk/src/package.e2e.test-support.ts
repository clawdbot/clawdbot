// Shared test-only support for packed @openclaw/sdk consumers.
import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mjs";
import { createPnpmRunnerSpawnSpec } from "../../../scripts/pnpm-runner.mjs";
import { type FileLockOptions, withFileLock } from "../../../src/infra/file-lock.js";
import { getWindowsSystem32ExePath } from "../../../src/infra/windows-install-roots.js";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";

type CommandResult = {
  stdout: string;
  stderr: string;
};

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
};

type PackedPackage = {
  manifest: PackageManifest;
  tarball: string;
};

const SDK_PACKAGE_BUILD_LOCK_OPTIONS = {
  retries: {
    retries: 180,
    factor: 1,
    minTimeout: 5_000,
    maxTimeout: 5_000,
    randomize: false,
  },
  stale: 20 * 60_000,
} satisfies FileLockOptions;

type PackedSdkConsumer = {
  root: string;
  run: (script: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

function createCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: process.env.CI ?? "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  };
}

export function signalCommandProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  runTaskkill: typeof spawnSync = spawnSync,
): void {
  if (process.platform === "win32") {
    if (typeof child.pid === "number") {
      const args = ["/PID", String(child.pid), "/T"];
      if (signal === "SIGKILL") {
        args.push("/F");
      }
      const taskkillPath = getWindowsSystem32ExePath("taskkill.exe");
      const result = runTaskkill(taskkillPath, args, { stdio: "ignore", windowsHide: true });
      if (!result.error && result.status === 0) {
        return;
      }
      if (signal !== "SIGKILL") {
        const forceResult = runTaskkill(taskkillPath, [...args, "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        if (!forceResult.error && forceResult.status === 0) {
          return;
        }
      }
    }
    child.kill(signal);
    return;
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }
  }
  child.kill(signal);
}

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
      env: options.env ?? createCommandEnv(),
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => {
      signalCommandProcess(child, "SIGKILL");
      reject(
        new Error(
          `command timed out after ${options.timeoutMs ?? 120_000}ms: ${[command, ...args].join(
            " ",
          )}`,
        ),
      );
    }, options.timeoutMs ?? 120_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `command failed (${String(code ?? signal)}): ${[command, ...args].join(" ")}\n` +
            `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        ),
      );
    });
  });
}

function runPnpmCommand(
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  const spec = createPnpmRunnerSpawnSpec({
    cwd: options.cwd,
    env: createCommandEnv(),
    pnpmArgs: args,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return runCommand(spec.command, spec.args, {
    cwd: typeof spec.options.cwd === "string" ? spec.options.cwd : options.cwd,
    env: spec.options.env,
    shell: spec.options.shell,
    timeoutMs: options.timeoutMs,
    windowsVerbatimArguments: spec.options.windowsVerbatimArguments,
  });
}

function runNpmCommand(
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  const env = createCommandEnv();
  const runner = resolveNpmRunner({ env, npmArgs: args });
  return runCommand(runner.command, runner.args, {
    cwd: options.cwd,
    env: runner.env ?? env,
    shell: runner.shell,
    timeoutMs: options.timeoutMs,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

function resolveWorkspacePackageRoot(repoRoot: string, packageName: string): string {
  const prefix = "@openclaw/";
  if (!packageName.startsWith(prefix)) {
    throw new Error(`unsupported workspace package name: ${packageName}`);
  }
  return path.join(repoRoot, "packages", packageName.slice(prefix.length));
}

async function readRawPackageManifest(packageRoot: string): Promise<PackageManifest> {
  return JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

async function normalizeWorkspaceDependencies(
  repoRoot: string,
  dependencies: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!dependencies) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies)) {
    normalized[name] =
      name.startsWith("@openclaw/") && spec.startsWith("workspace:")
        ? (await readRawPackageManifest(resolveWorkspacePackageRoot(repoRoot, name))).version
        : spec;
  }
  return normalized;
}

async function readPackageManifest(packageRoot: string): Promise<PackageManifest> {
  const manifest = await readRawPackageManifest(packageRoot);
  return {
    ...manifest,
    dependencies: await normalizeWorkspaceDependencies(
      path.resolve(packageRoot, "..", ".."),
      manifest.dependencies,
    ),
  };
}

async function collectWorkspacePackageRoots(params: {
  repoRoot: string;
  entryRoot: string;
}): Promise<string[]> {
  const orderedRoots: string[] = [];
  const visitedNames = new Set<string>();

  async function visit(packageRoot: string, expectedName?: string): Promise<void> {
    const manifest = await readRawPackageManifest(packageRoot);
    if (expectedName && manifest.name !== expectedName) {
      throw new Error(
        `workspace dependency ${expectedName} resolved to unexpected package ${manifest.name}`,
      );
    }
    if (visitedNames.has(manifest.name)) {
      return;
    }
    visitedNames.add(manifest.name);
    const workspaceDependencies = Object.entries(manifest.dependencies ?? {})
      .filter(([, spec]) => spec.startsWith("workspace:"))
      .map(([name]) => name)
      .toSorted();
    for (const dependencyName of workspaceDependencies) {
      await visit(resolveWorkspacePackageRoot(params.repoRoot, dependencyName), dependencyName);
    }
    orderedRoots.push(packageRoot);
  }

  await visit(params.entryRoot);
  return orderedRoots;
}

async function createPackStagingRoot(
  packageRoot: string,
  destinationRoot: string,
): Promise<string> {
  const manifest = await readPackageManifest(packageRoot);
  const packageSlug = manifest.name.replace(/^@/, "").replace("/", "-");
  const stagingRoot = path.join(destinationRoot, `pack-${packageSlug}`);
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(path.join(stagingRoot, "package.json"), JSON.stringify(manifest, null, 2));
  const files: string[] = Array.isArray(manifest.files) ? (manifest.files as string[]) : [];
  for (const entry of files) {
    if (typeof entry === "string") {
      await fs.cp(path.join(packageRoot, entry), path.join(stagingRoot, entry), {
        recursive: true,
      });
    }
  }
  return stagingRoot;
}

function tarballFileName(manifest: PackageManifest): string {
  return `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startOpenClawRegistry(packages: PackedPackage[]): Promise<{
  registryUrl: string;
  close: () => Promise<void>;
}> {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const byTarball = new Map(packages.map((pkg) => [path.basename(pkg.tarball), pkg]));
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.startsWith("/tarballs/")) {
      const pkg = byTarball.get(decodedPath.slice("/tarballs/".length));
      if (!pkg) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(pkg.tarball).pipe(res);
      return;
    }
    const pkg = byName.get(decodedPath.slice(1));
    if (!pkg) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name: pkg.manifest.name,
        "dist-tags": { latest: pkg.manifest.version },
        versions: {
          [pkg.manifest.version]: {
            ...pkg.manifest,
            dist: {
              tarball: `http://${host}/tarballs/${encodeURIComponent(path.basename(pkg.tarball))}`,
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("registry server did not bind to a TCP port");
  }
  return {
    registryUrl: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

export async function createPackedSdkConsumer(): Promise<PackedSdkConsumer> {
  const repoRoot = process.cwd();
  const packageRoots = await collectWorkspacePackageRoots({
    repoRoot,
    entryRoot: path.join(repoRoot, "packages", "sdk"),
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-consumer-"));
  try {
    const packedPackages: PackedPackage[] = [];
    const buildLockTarget = path.join(repoRoot, ".artifacts", "sdk-package-e2e-build");
    await fs.mkdir(path.dirname(buildLockTarget), { recursive: true });
    // SDK package builds clean shared dist directories. Keep build, staging,
    // packing, and validation atomic before consumers use private tarball roots.
    await withFileLock(buildLockTarget, SDK_PACKAGE_BUILD_LOCK_OPTIONS, async () => {
      for (const packageRoot of packageRoots) {
        const manifest = await readRawPackageManifest(packageRoot);
        await runPnpmCommand(
          ["--filter", manifest.name, manifest.scripts?.prepack ? "prepack" : "build"],
          { cwd: repoRoot, timeoutMs: 180_000 },
        );
      }
      for (const packageRoot of packageRoots) {
        const stagingRoot = await createPackStagingRoot(packageRoot, root);
        await runNpmCommand(["pack", "--ignore-scripts", "--pack-destination", root], {
          cwd: stagingRoot,
        });
      }
      for (const packageRoot of packageRoots) {
        const manifest = await readPackageManifest(packageRoot);
        const tarball = path.join(root, tarballFileName(manifest));
        await fs.stat(tarball);
        packedPackages.push({ manifest, tarball });
      }
    });
    const sdkTarball =
      packedPackages.find((pkg) => pkg.manifest.name === "@openclaw/sdk")?.tarball ?? "";
    if (!sdkTarball) {
      throw new Error("packed @openclaw/sdk tarball was not created");
    }
    const registry = await startOpenClawRegistry(packedPackages);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await fs.writeFile(path.join(root, ".npmrc"), `@openclaw:registry=${registry.registryUrl}`);
    try {
      await runNpmCommand(["install", "--ignore-scripts", "--no-audit", "--no-fund", sdkTarball], {
        cwd: root,
      });
    } finally {
      await registry.close();
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    run: async (script) => {
      await runCommand(process.execPath, createNodeEvalArgs(script, { evalFlag: "-e" }), {
        cwd: root,
      });
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
