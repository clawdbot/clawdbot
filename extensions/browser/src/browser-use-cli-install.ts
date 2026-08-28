import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, open as openFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "openclaw/plugin-sdk/process-runtime";
import { extractArchive } from "openclaw/plugin-sdk/setup-tools";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "./infra/tmp-openclaw-dir.js";

const BROWSER_HARNESS_VERSION = "0.1.10";
const UV_VERSION = "0.12.7";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_INSTALL_ERROR_CHARS = 30_000;

type UvAsset = { name: string; sha256: string };
type RunCommand = (argv: string[], options: CommandOptions) => Promise<SpawnResult>;

const UV_ASSETS: Record<string, UvAsset> = {
  "darwin-arm64": {
    name: "uv-aarch64-apple-darwin.tar.gz",
    sha256: "127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3",
  },
  "darwin-x64": {
    name: "uv-x86_64-apple-darwin.tar.gz",
    sha256: "06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959",
  },
  "linux-arm64-gnu": {
    name: "uv-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c",
  },
  "linux-arm64-musl": {
    name: "uv-aarch64-unknown-linux-musl.tar.gz",
    sha256: "6dcf60e3c085de88ace3671b949ca99f0652be561ff5627f0d21394140f041db",
  },
  "linux-x64-gnu": {
    name: "uv-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21",
  },
  "linux-x64-musl": {
    name: "uv-x86_64-unknown-linux-musl.tar.gz",
    sha256: "3d64d44ed67da7908dc7f5c4d64ebb44bad326fa17f8a0a52fc9a7793017bbe1",
  },
  "win32-arm64": {
    name: "uv-aarch64-pc-windows-msvc.zip",
    sha256: "1611d0f4be72b0a354ad9a6ae954093dd4c91e93e36b8b490326a05a039ffe14",
  },
  "win32-x64": {
    name: "uv-x86_64-pc-windows-msvc.zip",
    sha256: "bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218",
  },
};

export type ManagedBrowserUseCliRuntime = {
  kind: "managed";
  stateDir: string;
  rootDir: string;
  runtimeDir: string;
  daemonName: string;
  pathEnv: string;
  lang: string;
};

type ManagedPaths = ReturnType<typeof resolveManagedBrowserHarnessPaths>;
type ManagedInstallDeps = {
  ensureUv?: (paths: ManagedPaths) => Promise<string>;
  runCommand?: RunCommand;
};

const installationPromises = new Map<string, Promise<string>>();
const failedInstallRoots = new Set<string>();

export class BrowserHarnessInstallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserHarnessInstallError";
  }
}

function linuxLibc(): "gnu" | "musl" {
  const report: unknown = process.report?.getReport();
  const header = report && typeof report === "object" ? Reflect.get(report, "header") : undefined;
  const glibcVersion =
    header && typeof header === "object" ? Reflect.get(header, "glibcVersionRuntime") : undefined;
  return typeof glibcVersion === "string" && glibcVersion ? "gnu" : "musl";
}

function selectUvAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libc: "gnu" | "musl" = linuxLibc(),
): UvAsset | undefined {
  const suffix = platform === "linux" ? `-${libc}` : "";
  return UV_ASSETS[`${platform}-${arch}${suffix}`];
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

export function resolveManagedBrowserHarnessPaths(stateDir = resolveStateDir()) {
  const rootDir = path.join(stateDir, "tools", "browser-harness");
  return {
    rootDir,
    uvPath: path.join(rootDir, "uv", UV_VERSION, executableName("uv")),
    toolDir: path.join(rootDir, "tools"),
    binDir: path.join(rootDir, "bin"),
    pythonDir: path.join(rootDir, "python"),
    cacheDir: path.join(rootDir, "cache"),
    homeDir: path.join(rootDir, "home"),
    tmpDir: path.join(rootDir, "tmp"),
    executable: path.join(rootDir, "bin", executableName("browser-harness")),
  };
}

function copySelectedEnv(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  keys: string[],
) {
  for (const key of keys) {
    const value = source[key];
    if (value) {
      target[key] = value;
    }
  }
}

function baseManagedEnv(paths: ManagedPaths): Record<string, string> {
  const env: Record<string, string> = {
    HOME: paths.homeDir,
    USERPROFILE: paths.homeDir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    BH_HOME: paths.homeDir,
    BH_CONFIG_DIR: paths.homeDir,
    BH_AUTH_PATH: path.join(paths.homeDir, "auth.json"),
    BH_TELEMETRY: "0",
    BROWSER_HARNESS_TELEMETRY: "0",
    ANONYMIZED_TELEMETRY: "0",
    BH_RECORD: "0",
    BH_OPEN_LIVE_URL: "0",
    UV_TOOL_DIR: paths.toolDir,
    UV_TOOL_BIN_DIR: paths.binDir,
    UV_PYTHON_INSTALL_DIR: paths.pythonDir,
    UV_CACHE_DIR: paths.cacheDir,
    UV_MANAGED_PYTHON: "1",
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
  };
  copySelectedEnv(env, process.env, [
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]);
  return env;
}

async function runVersion(
  executable: string,
  expected: RegExp,
  env: Record<string, string>,
  runCommand: RunCommand = runCommandWithTimeout,
): Promise<boolean> {
  try {
    const result = await runCommand([executable, "--version"], {
      baseEnv: {},
      env,
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    return (
      result.code === 0 && result.termination === "exit" && expected.test(result.stdout.trim())
    );
  } catch {
    return false;
  }
}

async function downloadUvArchive(asset: UvAsset, destination: string): Promise<void> {
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.name}`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    requireHttps: true,
    maxRedirects: 5,
    timeoutMs: INSTALL_TIMEOUT_MS,
    capture: false,
    auditContext: "browser-harness-uv-download",
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`uv download failed: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`uv archive exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    const handle = await openFile(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let downloaded = 0;
    try {
      for await (const value of response.body.values()) {
        const chunk = Buffer.from(value);
        downloaded += chunk.byteLength;
        if (downloaded > MAX_DOWNLOAD_BYTES) {
          throw new Error(`uv archive exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    const actual = hash.digest("hex");
    if (actual !== asset.sha256) {
      throw new Error(`uv archive SHA-256 mismatch: expected ${asset.sha256}, got ${actual}`);
    }
  } finally {
    await release();
  }
}

async function findExecutable(root: string, name: string, depth = 0): Promise<string> {
  if (depth > 3) {
    throw new Error(`uv archive does not contain ${name}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) {
      return candidate;
    }
    if (entry.isDirectory()) {
      try {
        return await findExecutable(candidate, name, depth + 1);
      } catch {
        // Continue through the small verified archive.
      }
    }
  }
  throw new Error(`uv archive does not contain ${name}`);
}

async function ensureManagedUv(paths: ManagedPaths): Promise<string> {
  const env = baseManagedEnv(paths);
  const exactVersion = new RegExp(`^uv ${UV_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`);
  if (await runVersion(paths.uvPath, exactVersion, env)) {
    return paths.uvPath;
  }
  const asset = selectUvAsset();
  if (!asset) {
    throw new Error(
      `Browser Harness auto-install is unsupported on ${process.platform}/${process.arch}`,
    );
  }
  const archivePath = path.join(paths.rootDir, `.uv-${randomUUID()}-${asset.name}`);
  const extractDir = path.join(paths.rootDir, `.uv-extract-${randomUUID()}`);
  const partialPath = `${paths.uvPath}.partial-${randomUUID()}`;
  await Promise.all([
    mkdir(paths.rootDir, { recursive: true, mode: 0o700 }),
    mkdir(extractDir, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(paths.uvPath), { recursive: true, mode: 0o700 }),
  ]);
  try {
    await downloadUvArchive(asset, archivePath);
    await extractArchive({
      archivePath,
      destDir: extractDir,
      timeoutMs: 60_000,
      limits: {
        maxArchiveBytes: MAX_DOWNLOAD_BYTES,
        maxEntries: 16,
        maxEntryBytes: 64 * 1024 * 1024,
        maxExtractedBytes: 96 * 1024 * 1024,
      },
    });
    const extracted = await findExecutable(extractDir, executableName("uv"));
    await copyFile(extracted, partialPath, fsConstants.COPYFILE_EXCL);
    await chmod(partialPath, 0o755).catch(() => undefined);
    try {
      await rename(partialPath, paths.uvPath);
    } catch (error) {
      if (!(await runVersion(paths.uvPath, exactVersion, env))) {
        throw error;
      }
    }
    if (!(await runVersion(paths.uvPath, exactVersion, env))) {
      throw new Error(`managed uv ${UV_VERSION} failed validation`);
    }
    return paths.uvPath;
  } finally {
    await Promise.all([
      rm(archivePath, { force: true }).catch(() => undefined),
      rm(extractDir, { recursive: true, force: true }).catch(() => undefined),
      rm(partialPath, { force: true }).catch(() => undefined),
    ]);
  }
}

function capInstallError(value: string): string {
  return value.length <= MAX_INSTALL_ERROR_CHARS
    ? value
    : `${value.slice(0, MAX_INSTALL_ERROR_CHARS)}\n...[truncated]`;
}

export async function ensureManagedBrowserHarness(
  params: {
    stateDir?: string;
    deps?: ManagedInstallDeps;
  } = {},
): Promise<string> {
  const paths = resolveManagedBrowserHarnessPaths(params.stateDir);
  const pending =
    installationPromises.get(paths.rootDir) ??
    (async () => {
      const runCommand = params.deps?.runCommand ?? runCommandWithTimeout;
      await Promise.all(
        [
          paths.rootDir,
          paths.toolDir,
          paths.binDir,
          paths.pythonDir,
          paths.cacheDir,
          paths.homeDir,
          paths.tmpDir,
        ].map(async (dir) => await mkdir(dir, { recursive: true, mode: 0o700 })),
      );
      const env = baseManagedEnv(paths);
      const exactVersion = new RegExp(`^${BROWSER_HARNESS_VERSION.replaceAll(".", "\\.")}$`);
      if (await runVersion(paths.executable, exactVersion, env, runCommand)) {
        return paths.executable;
      }
      const uv = await (params.deps?.ensureUv ?? ensureManagedUv)(paths);
      const result = await runCommand(
        [
          uv,
          "--no-config",
          "--no-progress",
          "--color",
          "never",
          "tool",
          "install",
          "--python",
          "3.12",
          "--managed-python",
          "--force",
          `browser-harness==${BROWSER_HARNESS_VERSION}`,
        ],
        {
          baseEnv: {},
          env,
          timeoutMs: INSTALL_TIMEOUT_MS,
          killProcessTree: true,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
      );
      if (result.code !== 0 || result.termination !== "exit") {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`uv tool install failed${detail ? `: ${capInstallError(detail)}` : ""}`);
      }
      if (!(await runVersion(paths.executable, exactVersion, env, runCommand))) {
        throw new Error(
          `Browser Harness ${BROWSER_HARNESS_VERSION} failed validation after install`,
        );
      }
      return paths.executable;
    })();
  installationPromises.set(paths.rootDir, pending);
  try {
    const executable = await pending;
    failedInstallRoots.delete(paths.rootDir);
    return executable;
  } catch (error) {
    failedInstallRoots.add(paths.rootDir);
    throw new BrowserHarnessInstallError(
      `OpenClaw could not install Browser Harness ${BROWSER_HARNESS_VERSION}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (installationPromises.get(paths.rootDir) === pending) {
      installationPromises.delete(paths.rootDir);
    }
  }
}

export function isManagedBrowserHarnessUnavailable(stateDir = resolveStateDir()): boolean {
  return failedInstallRoots.has(resolveManagedBrowserHarnessPaths(stateDir).rootDir);
}

export function prepareManagedBrowserUseCliRuntime(
  params: {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ManagedBrowserUseCliRuntime | undefined {
  if (!selectUvAsset()) {
    return undefined;
  }
  const stateDir = params.stateDir ?? resolveStateDir();
  const paths = resolveManagedBrowserHarnessPaths(stateDir);
  const env = params.env ?? process.env;
  const runtimeHash = createHash("sha256")
    .update(path.resolve(stateDir))
    .digest("hex")
    .slice(0, 12);
  return {
    kind: "managed",
    stateDir,
    rootDir: paths.rootDir,
    runtimeDir: path.join(resolvePreferredOpenClawTmpDir(), `oc-bh-${runtimeHash}`),
    daemonName: "openclaw",
    pathEnv: `${paths.binDir}${path.delimiter}${env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    lang: env.LANG ?? "C.UTF-8",
  };
}
