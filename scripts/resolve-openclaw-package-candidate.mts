#!/usr/bin/env node
// Normalizes package-acceptance inputs into the tarball shape consumed by Docker E2E.
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup as dnsLookupCb } from "node:dns";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { isRecord as isJsonRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { toErrorObject } from "./lib/error-format.mts";
import { resolveNpmJsonEntries } from "./lib/npm-json-output.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";
import { resolveNpmRunner } from "./npm-runner.mts";
import { createPrepublishPluginRegistryArtifact } from "./prepublish-plugin-registry-artifact.mjs";

const ROOT_DIR = resolveRepoRoot(import.meta.url);
const DEFAULT_OUTPUT_NAME = "openclaw-current.tgz";
const PACKAGE_URL_DOWNLOAD_TIMEOUT_MS = 60_000;
const PACKAGE_URL_MAX_BYTES = 250 * 1024 * 1024;
const PACKAGE_URL_MAX_REDIRECTS = 5;
export const ARTIFACT_TARBALL_SCAN_MAX_ENTRIES = 10_000;
const COMMAND_STDOUT_CAPTURE_MAX_CHARS = 8 * 1024 * 1024;
const COMMAND_STDERR_CAPTURE_MAX_CHARS = 128 * 1024;
const COMMAND_TIMEOUT_KILL_AFTER_MS = 5_000;
const FORWARDED_SIGNAL_KILL_AFTER_MS = 250;
const COMMAND_PROCESS_TREE_EXIT_POLL_MS = 50;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
type ChildSignal = ChildProcess["signalCode"];
type ProcessSignal = Parameters<ChildProcess["kill"]>[0];
type TimerHandle = ReturnType<typeof setTimeout>;
type ChildKiller = (signal: ProcessSignal) => void;
type ProcessTreeChild = Pick<ChildProcess, "exitCode" | "kill" | "pid" | "signalCode">;
type ProcessTreeSignalTarget = Pick<ChildProcess, "kill" | "pid">;
type CommandOutputBuffer = {
  text: string;
  truncatedChars: number;
};

type RunOptions = {
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  killAfterMs?: unknown;
  shell?: boolean | string;
  timeoutMs?: unknown;
  windowsVerbatimArguments?: boolean;
};

type RunCommand = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<unknown>;

type NpmPackageCandidatePackRunner = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

type PackageCandidateOptions = {
  artifactDir: string;
  githubOutput: string;
  metadata: string;
  outputDir: string;
  outputName: string;
  packageRef: string;
  packageSha256: string;
  packageSpec: string;
  packageUrl: string;
  pluginRegistryOutputDir: string;
  requiredPluginPackagesJson: string;
  source: string;
  trustedSourceId: string;
  trustedSourcePolicy: string;
  help?: true;
};

type Ipv4Octets = [number, number, number, number];

type TrustedPackageSource = {
  allowPrivateNetwork: boolean;
  auth?: { type: string };
  hosts: string[];
  id: string;
  pathPrefixes: string[];
  ports: number[];
  redirectHosts: string[];
};

type PackageLookupHost = (hostname: string) => Promise<unknown>;

type WebResponseBody = {
  cancel(reason?: unknown): Promise<unknown>;
  getReader(): {
    cancel(reason?: unknown): Promise<unknown>;
    read(): Promise<ReadableStreamReadResult<string | Uint8Array>>;
    releaseLock(): void;
  };
};

type NodeResponseBody = {
  destroy(error?: Error): void;
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
};
type PackageResponseBody = WebResponseBody | NodeResponseBody;
type PackageDownloadResponse = {
  body: PackageResponseBody | null;
  headers: { get(name: string): string | null };
  status: number;
};
type PackageFetch = (
  input: URL,
  init?: RequestInit,
) => PackageDownloadResponse | Promise<PackageDownloadResponse>;
type PackageDownloadOptions = {
  addresses?: string[];
  fetchImpl?: PackageFetch;
  headers?: Record<string, string>;
  lookupHost?: PackageLookupHost;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: unknown;
  trustedSource?: TrustedPackageSource;
};
type ArtifactMetadata = Record<string, unknown>;

const ACTIVE_CHILD_KILLERS = new Set<ChildKiller>();
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const;
type ForwardedSignal = keyof typeof SIGNAL_EXIT_CODES;
const TRUSTED_PACKAGE_SOURCE_POLICY = ".github/package-trusted-sources.json";
const TRUSTED_PACKAGE_SOURCE_TOKEN_ENV = "OPENCLAW_TRUSTED_PACKAGE_TOKEN";
const BLOCKED_PACKAGE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);
let forwardedSignalExitCode: number | undefined;
let forwardedSignalForceKillTimer: TimerHandle | undefined;

for (const signal of Object.keys(SIGNAL_EXIT_CODES) as ForwardedSignal[]) {
  process.on(signal, () => {
    forwardedSignalExitCode ??= SIGNAL_EXIT_CODES[signal];
    if (ACTIVE_CHILD_KILLERS.size === 0) {
      process.exit(forwardedSignalExitCode);
    }
    const activeKillers = Array.from(ACTIVE_CHILD_KILLERS);
    for (const killChild of activeKillers) {
      killChild(signal);
    }
    forwardedSignalForceKillTimer ??= setTimeout(() => {
      for (const killChild of activeKillers) {
        killChild("SIGKILL");
      }
      process.exit(forwardedSignalExitCode);
    }, FORWARDED_SIGNAL_KILL_AFTER_MS);
  });
}
export const OPENCLAW_PACKAGE_SPEC_RE =
  /^openclaw@(alpha|beta|extended-stable|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-(alpha|beta)\.[1-9][0-9]*)?)$/u;

function usage() {
  return `Usage: node --import tsx scripts/resolve-openclaw-package-candidate.mts --source <ref|npm|url|trusted-url|artifact> --output-dir <dir> [options]

Options:
  --package-spec <spec>       Published npm spec for source=npm.
  --package-ref <ref>         Trusted repo ref for source=ref or npm companion packaging.
  --package-url <url>         HTTPS tarball URL for source=url or source=trusted-url.
  --package-sha256 <sha256>   Expected tarball SHA-256 for source=url, source=trusted-url, or source=artifact.
  --trusted-source-id <id>    Named trusted URL policy for source=trusted-url.
  --trusted-source-policy <file>
                              Repo-controlled trusted URL source policy. Default: ${TRUSTED_PACKAGE_SOURCE_POLICY}
  --artifact-dir <dir>        Directory containing exactly one .tgz for source=artifact.
  --output-name <name>        Output tarball filename. Default: ${DEFAULT_OUTPUT_NAME}
  --metadata <file>           Write package metadata JSON.
  --plugin-registry-output-dir <dir>
                              Build an immutable registry for source=ref before cleanup.
  --required-plugin-packages-json <json>
                              Scoped package names to include in that registry.
  --github-output <file>      Append tarball, sha256, package name/version outputs.`;
}

export function parseArgs(argv: readonly string[]) {
  const options: PackageCandidateOptions = {
    artifactDir: "",
    githubOutput: "",
    metadata: "",
    outputDir: "",
    outputName: DEFAULT_OUTPUT_NAME,
    packageRef: "",
    packageSha256: "",
    packageSpec: "",
    packageUrl: "",
    pluginRegistryOutputDir: "",
    requiredPluginPackagesJson: "[]",
    source: "",
    trustedSourceId: "",
    trustedSourcePolicy: TRUSTED_PACKAGE_SOURCE_POLICY,
  };
  parseFlagArgs(
    argv,
    options,
    [
      ...(
        [
          ["--artifact-dir", "artifactDir"],
          ["--github-output", "githubOutput"],
          ["--metadata", "metadata"],
          ["--output-dir", "outputDir"],
          ["--output-name", "outputName"],
          ["--plugin-registry-output-dir", "pluginRegistryOutputDir"],
          ["--required-plugin-packages-json", "requiredPluginPackagesJson"],
          ["--source", "source"],
          ["--trusted-source-policy", "trustedSourcePolicy"],
        ] as const
      ).map(([flag, key]) =>
        stringFlag(flag, key, { allowInline: false, rejectShortOptions: true }),
      ),
      ...(
        [
          ["--package-ref", "packageRef"],
          ["--package-spec", "packageSpec"],
          ["--package-url", "packageUrl"],
          ["--trusted-source-id", "trustedSourceId"],
        ] as const
      ).map(([flag, key]) =>
        stringFlag(flag, key, {
          allowEmpty: true,
          allowInline: false,
          rejectShortOptions: true,
        }),
      ),
      stringFlag("--package-sha256", "packageSha256", {
        allowEmpty: true,
        allowInline: false,
        rejectShortOptions: true,
        transform: (value: string) => value.toLowerCase(),
      }),
      booleanFlag("--help", "help", true, { repeatable: true }),
      booleanFlag("-h", "help", true, { repeatable: true }),
    ],
    {
      ignoreDoubleDash: false,
      onUnhandledArg(arg: string) {
        throw new Error(`unknown argument: ${arg}`);
      },
    },
  );
  validateOutputName(options.outputName);
  return options;
}

function validateOutputName(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.t(?:ar\.)?gz$/u.test(value)) {
    throw new Error(`--output-name must be a tarball filename, not a path: ${value}`);
  }
}

function resolvePackedOpenClawTarballFilename(value: unknown) {
  const filename = typeof value === "string" ? value.trim() : "";
  if (
    !/^openclaw-[A-Za-z0-9._-]+\.tgz$/u.test(filename) ||
    filename.includes("\0") ||
    filename !== path.basename(filename) ||
    filename !== path.win32.basename(filename)
  ) {
    throw new Error(
      `npm pack reported unsafe OpenClaw tarball filename: ${JSON.stringify(filename)}`,
    );
  }
  return filename;
}

export function validateOpenClawPackageSpec(spec: string) {
  if (!OPENCLAW_PACKAGE_SPEC_RE.test(spec)) {
    throw new Error(
      `package_spec must be openclaw@alpha, openclaw@beta, openclaw@extended-stable, openclaw@latest, or an exact OpenClaw release version; got: ${spec}`,
    );
  }
}

export function resolveNpmPackageCandidatePackRunner(
  packageSpec: string,
  outputDir: string,
  params: {
    comSpec?: string;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    existsSync?: (candidate: string) => boolean;
    platform?: typeof process.platform;
  } = {},
): NpmPackageCandidatePackRunner {
  validateOpenClawPackageSpec(packageSpec);
  return resolveNpmRunner({
    comSpec: params.comSpec,
    env: params.env,
    execPath: params.execPath,
    existsSync: params.existsSync,
    npmArgs: ["pack", packageSpec, "--ignore-scripts", "--json", "--pack-destination", outputDir],
    platform: params.platform,
  });
}

function numericTimerValueMs(valueMs: unknown) {
  const value = Number(valueMs);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function resolvePackageCandidateTimeoutMs(
  valueMs: unknown,
  fallbackMs: unknown = MAX_TIMER_TIMEOUT_MS,
) {
  const value = numericTimerValueMs(valueMs) ?? numericTimerValueMs(fallbackMs);
  return Math.min(Math.max(value ?? MAX_TIMER_TIMEOUT_MS, 1), MAX_TIMER_TIMEOUT_MS);
}

function resolveOptionalTimerTimeoutMs(valueMs: unknown) {
  if (valueMs === undefined) {
    return undefined;
  }
  return resolvePackageCandidateTimeoutMs(valueMs, 1);
}

function run(command: string, args: readonly string[], options: RunOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    const resolvedTimeoutMs = resolveOptionalTimerTimeoutMs(options.timeoutMs);
    const resolvedKillAfterMs = resolvePackageCandidateTimeoutMs(
      options.killAfterMs,
      COMMAND_TIMEOUT_KILL_AFTER_MS,
    );
    const useProcessGroup = process.platform !== "win32";
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd ?? ROOT_DIR,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      ...(options.env ? { env: options.env } : {}),
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      ...(options.windowsVerbatimArguments !== undefined
        ? { windowsVerbatimArguments: options.windowsVerbatimArguments }
        : {}),
      detached: useProcessGroup,
    };
    const child = spawn(command, args, spawnOptions);
    let timedOut = false;
    let killTimer: TimerHandle | undefined;
    let forceKillAt: number | undefined;
    const killChild: ChildKiller = (signal) =>
      signalChildProcessTree(child, signal, { useProcessGroup });
    const terminateChild = () => {
      killChild("SIGTERM");
      forceKillAt = Date.now() + resolvedKillAfterMs;
      killTimer = setTimeout(() => {
        killTimer = undefined;
        forceKillAt = undefined;
        killChild("SIGKILL");
      }, resolvedKillAfterMs);
    };
    const timeout =
      resolvedTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateChild();
          }, resolvedTimeoutMs);
    timeout?.unref?.();
    ACTIVE_CHILD_KILLERS.add(killChild);
    let stdout = { text: "", truncatedChars: 0 };
    let stderr = { text: "", truncatedChars: 0 };
    if (options.capture) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendBoundedCommandOutput(stdout, chunk, COMMAND_STDOUT_CAPTURE_MAX_CHARS);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendBoundedCommandOutput(stderr, chunk, COMMAND_STDERR_CAPTURE_MAX_CHARS);
      });
    }
    child.on("error", (error: Error) => {
      ACTIVE_CHILD_KILLERS.delete(killChild);
      reject(toErrorObject(error, "Non-Error rejection"));
    });
    child.on("close", (status: number | null, signal: ChildSignal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimer && !timedOut) {
        clearTimeout(killTimer);
        forceKillAt = undefined;
      }
      ACTIVE_CHILD_KILLERS.delete(killChild);
      if (
        forwardedSignalExitCode !== undefined &&
        ACTIVE_CHILD_KILLERS.size === 0 &&
        forwardedSignalForceKillTimer === undefined
      ) {
        process.exit(forwardedSignalExitCode);
      }
      if (forwardedSignalExitCode !== undefined) {
        return;
      }
      if (timedOut) {
        const timeoutError = new Error(
          `${command} ${args.join(" ")} timed out after ${resolvedTimeoutMs}ms`,
        );
        if (killTimer) {
          void finishTimedOutProcessTree(child, {
            forceKillAt,
            killChild,
            killTimer,
            killAfterMs: resolvedKillAfterMs,
            useProcessGroup,
          }).then(() => reject(timeoutError), reject);
          return;
        }
        reject(timeoutError);
        return;
      }
      if (status === 0) {
        if (stdout.truncatedChars > 0) {
          reject(
            new Error(
              `${command} ${args.join(" ")} produced more than ${COMMAND_STDOUT_CAPTURE_MAX_CHARS} captured stdout chars`,
            ),
          );
          return;
        }
        resolve(stdout.text);
        return;
      }
      const stderrText = formatCapturedCommandOutput(stderr).trim();
      const detail = stderrText ? `\n${stderrText}` : "";
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}${detail}`));
    });
  });
}

async function finishTimedOutProcessTree(
  child: ProcessTreeChild,
  {
    forceKillAt,
    killAfterMs,
    killChild,
    killTimer,
    useProcessGroup,
  }: {
    forceKillAt: number | undefined;
    killAfterMs: number;
    killChild: ChildKiller;
    killTimer: TimerHandle;
    useProcessGroup: boolean;
  },
) {
  const graceRemainingMs =
    forceKillAt === undefined ? killAfterMs : Math.max(0, forceKillAt - Date.now());
  if (graceRemainingMs > 0) {
    await waitForProcessTreeExit(child, graceRemainingMs, useProcessGroup);
  }
  clearTimeout(killTimer);
  if (processTreeIsAlive(child, useProcessGroup)) {
    killChild("SIGKILL");
    await waitForProcessTreeExit(child, killAfterMs, useProcessGroup);
  }
}

export function signalChildProcessTree(
  processChild: ProcessTreeSignalTarget,
  processSignal: ProcessSignal,
  {
    platform = process.platform,
    runTaskkill = (command, args, options) => spawnSync(command, args, options),
    useProcessGroup = platform !== "win32",
  }: {
    platform?: typeof process.platform;
    runTaskkill?:
      | ((
          command: string,
          args: readonly string[],
          options: { stdio: "ignore" },
        ) => { error?: Error; status: number | null })
      | undefined;
    useProcessGroup?: boolean | undefined;
  } = {},
) {
  if (useProcessGroup && processChild.pid) {
    try {
      process.kill(-processChild.pid, processSignal);
      return;
    } catch {
      // The process group can disappear between timeout and cleanup.
    }
  }
  if (platform === "win32" && typeof processChild.pid === "number") {
    const taskkillPath = resolveWindowsTaskkillPath();
    const args = ["/PID", String(processChild.pid), "/T"];
    if (processSignal === "SIGKILL") {
      args.push("/F");
    }
    const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
    if (!result?.error && result?.status === 0) {
      return;
    }
    if (processSignal !== "SIGKILL") {
      const forceResult = runTaskkill(taskkillPath, [...args, "/F"], { stdio: "ignore" });
      if (!forceResult?.error && forceResult?.status === 0) {
        return;
      }
    }
  }
  processChild.kill(processSignal);
}

function childHasExited(child: ProcessTreeChild) {
  return child.exitCode !== null || child.signalCode !== null;
}

function processTreeIsAlive(child: ProcessTreeChild, useProcessGroup: boolean) {
  if (!child || typeof child.pid !== "number") {
    return false;
  }
  if (!useProcessGroup) {
    return !childHasExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function waitForProcessTreeExit(
  child: ProcessTreeChild,
  timeoutMs: number,
  useProcessGroup: boolean,
) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!processTreeIsAlive(child, useProcessGroup)) {
      return true;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, COMMAND_PROCESS_TREE_EXIT_POLL_MS);
    });
  }
  return !processTreeIsAlive(child, useProcessGroup);
}

function appendBoundedCommandOutput(
  buffer: CommandOutputBuffer,
  chunk: string | Uint8Array,
  maxChars: number,
) {
  const nextText = buffer.text + String(chunk);
  if (nextText.length <= maxChars) {
    return { text: nextText, truncatedChars: buffer.truncatedChars };
  }
  const truncatedChars = buffer.truncatedChars + nextText.length - maxChars;
  return { text: nextText.slice(-maxChars), truncatedChars };
}

function formatCapturedCommandOutput(buffer: CommandOutputBuffer) {
  if (buffer.truncatedChars === 0) {
    return buffer.text;
  }
  return `[output truncated ${buffer.truncatedChars} chars; showing tail]\n${buffer.text}`;
}

export const runCommandForTest = run;

async function sha256(file: string) {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error(`package_sha256 must be a lowercase or uppercase 64-character SHA-256 digest`);
  }
}

async function assertExpectedSha256(file: string, expected: string) {
  if (!expected) {
    return await sha256(file);
  }
  assertSha256(expected);
  const actual = await sha256(file);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`package SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export const assertExpectedSha256ForTest = assertExpectedSha256;

async function findSingleTarball(dir: string, maxEntries = ARTIFACT_TARBALL_SCAN_MAX_ENTRIES) {
  const root = path.resolve(ROOT_DIR, dir);
  const pending = [root];
  const tarballs = [];
  let scannedEntries = 0;

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }
    const handle = await fs.opendir(currentDir);
    for await (const entry of handle) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) {
        throw new Error(
          `source=artifact scan exceeded ${maxEntries} filesystem entries under ${dir}; provide a smaller artifact directory containing exactly one .tgz.`,
        );
      }

      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (entry.isFile() && /\.t(?:ar\.)?gz$/u.test(entry.name)) {
        tarballs.push(absolute);
        if (tarballs.length > 1) {
          const relativeTarballs = tarballs
            .map((tarball) => path.relative(root, tarball))
            .toSorted((a, b) => a.localeCompare(b));
          throw new Error(
            `source=artifact requires exactly one .tgz under ${dir}; found at least 2: ${relativeTarballs.join(", ")}`,
          );
        }
      }
    }
  }

  if (tarballs.length !== 1) {
    throw new Error(
      `source=artifact requires exactly one .tgz under ${dir}; found ${tarballs.length}: ${tarballs.join(", ")}`,
    );
  }
  return tarballs[0]!;
}

export const findSingleTarballForTest = findSingleTarball;

export async function readArtifactPackageCandidateMetadata(dir: string) {
  const metadataPath = path.join(path.resolve(ROOT_DIR, dir), "package-candidate.json");
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonRecord(parsed)) {
    throw new Error(`artifact package-candidate.json must contain a JSON object`);
  }
  const packageSourceSha =
    typeof parsed.packageSourceSha === "string" ? parsed.packageSourceSha.trim() : "";
  if (packageSourceSha && !/^[0-9a-f]{40}$/iu.test(packageSourceSha)) {
    throw new Error(
      "artifact package-candidate.json packageSourceSha must be a 40-character commit SHA",
    );
  }
  if (typeof parsed.packageSourceSha === "string") {
    return packageSourceSha
      ? { ...parsed, packageSourceSha: packageSourceSha.toLowerCase() }
      : { ...parsed, packageSourceSha: "" };
  }
  return parsed;
}

async function revParseTrustedInputRef(ref: string) {
  const candidates = [ref, `refs/remotes/origin/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const resolved = await run("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
      capture: true,
    }).then(
      (value) => value.trim(),
      () => "",
    );
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(`package_ref does not resolve to a commit: ${ref}`);
}

async function resolveTrustedRepoRef(ref: string) {
  if (!ref || ref.trim() === "" || ref.startsWith("-")) {
    throw new Error(
      `package_ref must be a branch, tag, or full commit SHA; got: ${ref || "<empty>"}`,
    );
  }

  await run("git", ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  await run("git", ["fetch", "--tags", "origin", "+refs/tags/*:refs/tags/*"]);

  const selectedSha = await revParseTrustedInputRef(ref);
  const isMainAncestor = await run("git", [
    "merge-base",
    "--is-ancestor",
    selectedSha,
    "refs/remotes/origin/main",
  ]).then(
    () => true,
    () => false,
  );
  if (isMainAncestor) {
    return { selectedSha, trustedReason: "main-ancestor" };
  }

  const releaseTags = (await run("git", ["tag", "--points-at", selectedSha], { capture: true }))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (releaseTags.some((tag) => tag.startsWith("v"))) {
    return { selectedSha, trustedReason: "release-tag" };
  }

  const containingBranches = (
    await run(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        selectedSha,
        "refs/remotes/origin",
      ],
      { capture: true },
    )
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containingBranches.some((branch) => branch.startsWith("origin/"))) {
    return { selectedSha, trustedReason: "repository-branch-history" };
  }

  throw new Error(
    `package_ref ${ref} resolved to ${selectedSha}, which is not reachable from an OpenClaw branch or release tag`,
  );
}

async function preparePackageSourceWorktree(ref: string) {
  const { selectedSha, trustedReason } = await resolveTrustedRepoRef(ref);
  const sourceDir = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    `openclaw-package-source-${process.pid}`,
  );
  await fs.rm(sourceDir, { recursive: true, force: true });
  await run("git", ["worktree", "add", "--detach", sourceDir, selectedSha]);
  return { selectedSha, sourceDir, trustedReason };
}

async function cleanupPackageSourceWorktree(
  sourceDir: string,
  {
    resolveError,
    runImpl = run,
    consoleError = console.error,
  }: {
    resolveError?: unknown;
    runImpl?: RunCommand;
    consoleError?: (message: string) => void;
  } = {},
) {
  try {
    await runImpl("git", ["worktree", "remove", "--force", sourceDir]);
  } catch (cleanupError) {
    if (!resolveError) {
      throw cleanupError;
    }
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    consoleError(
      `warning: failed to remove temporary package source worktree ${sourceDir}: ${message}`,
    );
  }
}

export const cleanupPackageSourceWorktreeForTest = cleanupPackageSourceWorktree;

async function installPackageSourceDeps(sourceDir: string) {
  await run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts=false",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=true",
    ],
    { cwd: sourceDir },
  );
}

async function moveNewestPackedTarball(outputDir: string, packOutput: string, outputName: string) {
  let filename = "";
  let parsed;
  try {
    parsed = JSON.parse(packOutput);
  } catch {}
  if (parsed !== undefined) {
    const packedEntry = resolveNpmJsonEntries(parsed).find(
      (entry): entry is Record<string, unknown> =>
        isJsonRecord(entry) && typeof entry.filename === "string",
    );
    const packedFilename =
      packedEntry && typeof packedEntry.filename === "string" ? packedEntry.filename : "";
    if (packedFilename) {
      filename = resolvePackedOpenClawTarballFilename(packedFilename);
    }
  }
  if (!filename) {
    for (const line of packOutput.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (
        trimmed.endsWith(".tgz") &&
        (trimmed.startsWith("openclaw-") ||
          trimmed.includes(":") ||
          trimmed.includes("/") ||
          trimmed.includes("\\"))
      ) {
        filename = resolvePackedOpenClawTarballFilename(trimmed);
      }
    }
  }
  if (!filename) {
    const entries = await fs.readdir(outputDir);
    filename =
      entries
        .filter((entry) => {
          try {
            return resolvePackedOpenClawTarballFilename(entry) === entry;
          } catch {
            return false;
          }
        })
        .toSorted((a, b) => a.localeCompare(b))
        .at(-1) ?? "";
  }
  if (!filename) {
    throw new Error(`npm pack produced no OpenClaw tarball in ${outputDir}`);
  }
  const packed = path.join(outputDir, filename);
  const target = path.join(outputDir, outputName);
  if (packed !== target) {
    await fs.rm(target, { force: true });
    await fs.rename(packed, target);
  }
  return target;
}

export const moveNewestPackedTarballForTest = moveNewestPackedTarball;

async function cleanPackedOpenClawTarballs(outputDir: string) {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }
  await Promise.all(
    entries
      .filter((entry) => {
        try {
          return resolvePackedOpenClawTarballFilename(entry) === entry;
        } catch {
          return false;
        }
      })
      .map((entry) => fs.rm(path.join(outputDir, entry), { force: true })),
  );
}

export const cleanPackedOpenClawTarballsForTest = cleanPackedOpenClawTarballs;

function normalizeUrlHostname(hostname: string): string {
  return hostname.replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.+$/u, "").toLowerCase();
}

function parseIpv4(address: string): Ipv4Octets | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part)) as Ipv4Octets;
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function ipv4ToInt(octets: Ipv4Octets) {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function ipv4InCidr(octets: Ipv4Octets, base: Ipv4Octets, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(octets) & mask) === (ipv4ToInt(base) & mask);
}

function isUnsafeIpv4(address: string | Ipv4Octets) {
  const octets = Array.isArray(address) ? address : parseIpv4(address);
  if (!octets) {
    return true;
  }
  const blockedRanges: Array<[Ipv4Octets, number]> = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24],
    [[192, 0, 2, 0], 24],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24],
    [[224, 0, 0, 0], 4],
    [[240, 0, 0, 0], 4],
  ];
  return blockedRanges.some(([base, bits]) => ipv4InCidr(octets, base, bits));
}

function ipv4FromHextets(high: number, low: number): Ipv4Octets {
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
}

function ipv4OctetsToHextets(octets: Ipv4Octets): [string, string] {
  return [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
}

function parseIpv6Parts(address: string): number[] | null {
  const normalized = address.toLowerCase().replace(/%[0-9a-z_.-]+$/u, "");
  const dottedIpv4 = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u);
  let canonical = normalized;
  if (dottedIpv4) {
    const dottedIpv4Octets = parseIpv4(dottedIpv4[2]!);
    if (!dottedIpv4Octets) {
      return null;
    }
    const [high, low] = ipv4OctetsToHextets(dottedIpv4Octets);
    canonical = `${dottedIpv4[1]!}${high}:${low}`;
  }
  if (canonical.includes(":::") || canonical.split("::").length > 2) {
    return null;
  }
  const [leftRaw = "", rightRaw = ""] = canonical.split("::");
  const parseParts = (value: string): number[] => {
    if (!value) {
      return [];
    }
    return value.split(":").map((part) => {
      if (!/^[0-9a-f]{1,4}$/u.test(part)) {
        return Number.NaN;
      }
      return Number.parseInt(part, 16);
    });
  };
  const left = parseParts(leftRaw);
  const right = parseParts(rightRaw);
  if ([...left, ...right].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    return null;
  }
  const zeroCount = canonical.includes("::") ? 8 - left.length - right.length : 0;
  if (zeroCount < 0 || (!canonical.includes("::") && left.length !== 8)) {
    return null;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function extractUnsafeEmbeddedIpv4FromIpv6(address: string): Ipv4Octets | null {
  const parts = parseIpv6Parts(address);
  if (!parts || parts.length !== 8) {
    return null;
  }
  const hextets = parts as [number, number, number, number, number, number, number, number];
  const candidates: Ipv4Octets[] = [];
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    candidates.push(ipv4FromHextets(hextets[6], hextets[7]));
  }
  if (hextets.slice(0, 6).every((part) => part === 0)) {
    candidates.push(ipv4FromHextets(hextets[6], hextets[7]));
  }
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets.slice(2, 6).every((part) => part === 0)
  ) {
    candidates.push(ipv4FromHextets(hextets[6], hextets[7]));
  }
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0x0001 &&
    hextets.slice(3, 6).every((part) => part === 0)
  ) {
    candidates.push(ipv4FromHextets(hextets[6], hextets[7]));
  }
  if (hextets[0] === 0x2002) {
    candidates.push(ipv4FromHextets(hextets[1], hextets[2]));
  }
  if (hextets[0] === 0x2001 && hextets[1] === 0x0000) {
    candidates.push(ipv4FromHextets(hextets[6] ^ 0xffff, hextets[7] ^ 0xffff));
  }
  if ((hextets[4] & 0xfcff) === 0 && hextets[5] === 0x5efe) {
    candidates.push(ipv4FromHextets(hextets[6], hextets[7]));
  }
  return candidates.find((candidate) => isUnsafeIpv4(candidate)) ?? null;
}

function isUnsafeIpv6(address: string) {
  const normalized = address.toLowerCase();
  if (extractUnsafeEmbeddedIpv4FromIpv6(normalized)) {
    return true;
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("64:ff9b:") ||
    normalized.startsWith("100:") ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:db8:")
  );
}

function isUnsafeIpAddress(address: string) {
  const normalized = normalizeUrlHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    return isUnsafeIpv4(normalized);
  }
  if (family === 6) {
    return isUnsafeIpv6(normalized);
  }
  return true;
}

function isBlockedPackageHostname(hostname: string) {
  const normalized = normalizeUrlHostname(hostname);
  return (
    BLOCKED_PACKAGE_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    (isIP(normalized) !== 0 && isUnsafeIpAddress(normalized))
  );
}

function packageUrlPort(parsed: URL) {
  return parsed.port ? Number(parsed.port) : 443;
}

function toUniqueNormalizedHostList(value: unknown, field: string, sourceId: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`trusted package source ${sourceId} must define non-empty ${field}`);
  }
  return [...new Set(value.map((entry) => normalizeUrlHostname(String(entry))).filter(Boolean))];
}

function toTrustedPorts(value: unknown, sourceId: string) {
  const ports = value === undefined ? [443] : value;
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error(`trusted package source ${sourceId} must define non-empty ports`);
  }
  const normalized = ports.map((port) => parseTrustedPort(port));
  if (normalized.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`trusted package source ${sourceId} has invalid ports`);
  }
  return [...new Set(normalized)].toSorted((a, b) => a - b);
}

function parseTrustedPort(value: unknown) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    return Number(value);
  }
  return Number.NaN;
}

function pathnameMatchesTrustedPrefix(pathname: string, prefix: string) {
  if (prefix === "/") {
    return true;
  }
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname === prefix || pathname.startsWith(normalizedPrefix);
}

function toPathPrefixes(value: unknown, sourceId: string) {
  const prefixes = value === undefined ? ["/"] : value;
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error(`trusted package source ${sourceId} must define non-empty pathPrefixes`);
  }
  return prefixes.map((prefix) => {
    const text = String(prefix);
    if (!text.startsWith("/")) {
      throw new Error(`trusted package source ${sourceId} pathPrefixes must start with /`);
    }
    return text;
  });
}

function normalizeTrustedPackageSource(id: string, raw: unknown): TrustedPackageSource {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(`Invalid trusted package source id: ${id}`);
  }
  if (!isJsonRecord(raw)) {
    throw new Error(`trusted package source ${id} must be an object`);
  }
  const hosts = toUniqueNormalizedHostList(raw.hosts, "hosts", id);
  const redirectHosts = raw.redirectHosts
    ? toUniqueNormalizedHostList(raw.redirectHosts, "redirectHosts", id)
    : hosts;
  const rawAuth = raw.auth;
  let auth: TrustedPackageSource["auth"];
  if (rawAuth !== undefined) {
    if (!isJsonRecord(rawAuth) || rawAuth.type !== "bearer") {
      throw new Error(`trusted package source ${id} auth must be {"type":"bearer"}`);
    }
    const authKeys = Object.keys(rawAuth);
    if (authKeys.some((key) => key !== "type")) {
      throw new Error(`trusted package source ${id} auth only supports type`);
    }
    auth = { type: "bearer" };
  }
  return {
    allowPrivateNetwork: raw.allowPrivateNetwork === true,
    auth,
    hosts,
    id,
    pathPrefixes: toPathPrefixes(raw.pathPrefixes, id),
    ports: toTrustedPorts(raw.ports, id),
    redirectHosts,
  };
}

export async function loadTrustedPackageSource(
  id: string,
  policyPath: string = TRUSTED_PACKAGE_SOURCE_POLICY,
): Promise<TrustedPackageSource> {
  if (!id) {
    throw new Error("source=trusted-url requires --trusted-source-id");
  }
  const absolutePolicyPath = path.resolve(ROOT_DIR, policyPath);
  const sourceId = id;
  let policy: unknown;
  try {
    policy = JSON.parse(await fs.readFile(absolutePolicyPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read trusted package source policy: ${policyPath}`, {
      cause: error,
    });
  }
  if (!isJsonRecord(policy) || policy.schemaVersion !== 1) {
    throw new Error(`Trusted package source policy must use schemaVersion 1: ${policyPath}`);
  }
  const sources = policy.sources;
  if (!isJsonRecord(sources)) {
    throw new Error(`Trusted package source policy must define sources: ${policyPath}`);
  }
  if (!Object.hasOwn(sources, sourceId)) {
    throw new Error(`Unknown trusted package source: ${sourceId}`);
  }
  return normalizeTrustedPackageSource(sourceId, sources[sourceId]);
}

function validateTrustedPackageDownloadUrl(
  parsed: URL,
  trustedSource: TrustedPackageSource,
  options: { isRedirect?: boolean } = {},
) {
  if (parsed.protocol !== "https:") {
    throw new Error(`package_url must use https: ${parsed.toString()}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`package_url must not include credentials: ${parsed.origin}`);
  }
  const hostname = normalizeUrlHostname(parsed.hostname);
  const allowedHosts = options.isRedirect ? trustedSource.redirectHosts : trustedSource.hosts;
  if (!allowedHosts.includes(hostname)) {
    throw new Error(
      `package_url host ${parsed.hostname} is not allowed by trusted package source ${trustedSource.id}`,
    );
  }
  if (!trustedSource.ports.includes(packageUrlPort(parsed))) {
    throw new Error(
      `package_url port ${packageUrlPort(parsed)} is not allowed by trusted package source ${trustedSource.id}`,
    );
  }
  if (
    !trustedSource.pathPrefixes.some((prefix) =>
      pathnameMatchesTrustedPrefix(parsed.pathname, prefix),
    )
  ) {
    throw new Error(
      `package_url path is not allowed by trusted package source ${trustedSource.id}`,
    );
  }
  if (!trustedSource.allowPrivateNetwork && isBlockedPackageHostname(parsed.hostname)) {
    throw new Error(
      `Blocked hostname or private/internal/special-use IP address: ${parsed.hostname}`,
    );
  }
}

function createTrustedPackageAuthHeaders(
  trustedSource: TrustedPackageSource | undefined,
  parsed: URL,
  initialOrigin: string,
) {
  if (!trustedSource?.auth) {
    return undefined;
  }
  if (parsed.origin !== initialOrigin) {
    return undefined;
  }
  const token = process.env[TRUSTED_PACKAGE_SOURCE_TOKEN_ENV];
  if (!token) {
    throw new Error(
      `trusted package source ${trustedSource.id} requires ${TRUSTED_PACKAGE_SOURCE_TOKEN_ENV}`,
    );
  }
  return { authorization: `Bearer ${token}` };
}

function validatePackageDownloadUrl(parsed: URL) {
  if (parsed.protocol !== "https:") {
    throw new Error(`package_url must use https: ${parsed.toString()}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`package_url must not include credentials: ${parsed.origin}`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`package_url must use the default HTTPS port: ${parsed.origin}`);
  }
  if (isBlockedPackageHostname(parsed.hostname)) {
    throw new Error(
      `Blocked hostname or private/internal/special-use IP address: ${parsed.hostname}`,
    );
  }
}

async function defaultLookupHost(hostname: string) {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeLookupResults(results: unknown): LookupAddress[] {
  const entries = Array.isArray(results) ? results : [results];
  return entries
    .map((entry) => ({
      address: isJsonRecord(entry) && typeof entry.address === "string" ? entry.address : "",
      family: Number(isJsonRecord(entry) ? (entry.family ?? 0) : 0),
    }))
    .filter((entry) => entry.address && (entry.family === 4 || entry.family === 6));
}

function createPinnedLookup(hostname: string, addresses: string[]): LookupFunction {
  const normalizedHost = normalizeUrlHostname(hostname);
  const records: LookupAddress[] = addresses.map((address) => ({
    address,
    family: isIP(normalizeUrlHostname(address)),
  }));
  type LookupCallback = (
    error: (Error & { code?: string }) | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;
  type PinnedLookupOptions = {
    all?: boolean;
    family?: number;
    hints?: number;
    verbatim?: boolean;
  };
  const lookup = (
    host: string,
    options: PinnedLookupOptions | LookupCallback,
    callback?: LookupCallback,
  ): void => {
    const cb = typeof options === "function" ? options : callback;
    if (!cb) {
      return;
    }
    if (normalizeUrlHostname(host) !== normalizedHost) {
      if (typeof options === "function") {
        dnsLookupCb(host, cb);
        return;
      }
      dnsLookupCb(host, options, cb);
      return;
    }
    const opts = typeof options === "object" && options !== null ? options : {};
    const filtered = opts.family
      ? records.filter((record) => record.family === opts.family)
      : records;
    const usable = filtered.length > 0 ? filtered : records;
    // Keep custom lookup delivery asynchronous so HTTPS owns immediate socket errors.
    if (opts.all) {
      process.nextTick(() => {
        cb(null, usable);
      });
      return;
    }
    const chosen = usable[0]!;
    process.nextTick(() => {
      cb(null, chosen.address, chosen.family);
    });
  };
  return lookup as LookupFunction;
}

async function resolvePackageDownloadAddresses(
  parsed: URL,
  lookupHost: PackageLookupHost,
  trustedSource: TrustedPackageSource | undefined,
) {
  const hostname = normalizeUrlHostname(parsed.hostname);
  if (isIP(hostname)) {
    if (!trustedSource?.allowPrivateNetwork && isUnsafeIpAddress(hostname)) {
      throw new Error(
        `Blocked: package_url resolves to private/internal/special-use IP address: ${hostname}`,
      );
    }
    return [hostname];
  }
  const results = normalizeLookupResults(await lookupHost(hostname));
  if (results.length === 0) {
    throw new Error(`Unable to resolve package_url hostname: ${parsed.hostname}`);
  }
  if (!trustedSource?.allowPrivateNetwork) {
    const blocked = results.find((entry) => isUnsafeIpAddress(entry.address));
    if (blocked) {
      throw new Error(
        `Blocked: package_url resolves to private/internal/special-use IP address: ${blocked.address}`,
      );
    }
  }
  return [...new Set(results.map((entry) => entry.address))];
}

function responseStatus(response: PackageDownloadResponse) {
  return response.status;
}

function responseOk(response: PackageDownloadResponse) {
  const status = responseStatus(response);
  return status >= 200 && status < 300;
}

function responseHeader(response: PackageDownloadResponse, name: string) {
  return response.headers?.get?.(name) ?? null;
}

function createPackageDownloadTimeoutError(parsed: URL, timeoutMs: number) {
  return Object.assign(
    new Error(`package_url download timed out after ${timeoutMs}ms: ${parsed.toString()}`),
    {
      code: "ETIMEDOUT",
    },
  );
}

async function closeResponseBody(body: PackageResponseBody | null) {
  if (!body) {
    return;
  }
  if (isWebResponseBody(body)) {
    await body.cancel().catch(() => {});
    return;
  }
  body.destroy();
}

async function openFetchPackageDownloadResponse(
  parsed: URL,
  options: Required<Pick<PackageDownloadOptions, "fetchImpl">> &
    Pick<PackageDownloadOptions, "headers"> & { timeoutMs: number },
) {
  const controller = new AbortController();
  const timeoutError = createPackageDownloadTimeoutError(parsed, options.timeoutMs);
  let timeout!: TimerHandle;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
    timeout.unref?.();
  });
  timeoutPromise.catch(() => {});
  const response = await Promise.resolve(
    options.fetchImpl(parsed, {
      headers: options.headers,
      redirect: "manual",
      signal: controller.signal,
    }),
  ).catch((error: unknown) => {
    clearTimeout(timeout);
    if (errorName(error) === "AbortError") {
      throw Object.assign(timeoutError, { cause: error });
    }
    throw error;
  });
  return {
    close: async () => closeResponseBody(response.body),
    response,
    timeout,
    timeoutPromise,
    timeoutMs: options.timeoutMs,
  };
}

async function openHttpsPackageDownloadResponse(
  parsed: URL,
  options: Required<Pick<PackageDownloadOptions, "addresses">> &
    Pick<PackageDownloadOptions, "headers"> & { timeoutMs: number },
) {
  const controller = new AbortController();
  const timeoutError = createPackageDownloadTimeoutError(parsed, options.timeoutMs);
  let timeout!: TimerHandle;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
    timeout.unref?.();
  });
  timeoutPromise.catch(() => {});
  const lookup = createPinnedLookup(parsed.hostname, options.addresses);
  const response = await new Promise<PackageDownloadResponse>((resolve, reject) => {
    const request = httpsRequest(
      parsed,
      {
        headers: options.headers,
        lookup,
        signal: controller.signal,
      },
      (message) => {
        resolve({
          body: message,
          headers: {
            get(name) {
              const value = message.headers[name.toLowerCase()];
              if (Array.isArray(value)) {
                return value[0] ?? null;
              }
              return value ?? null;
            },
          },
          status: message.statusCode ?? 0,
        });
      },
    );
    request.on("error", reject);
    request.end();
  }).catch((error: unknown) => {
    clearTimeout(timeout);
    if (errorName(error) === "AbortError" || errorCode(error) === "ABORT_ERR") {
      throw Object.assign(timeoutError, { cause: error });
    }
    throw error;
  });
  return {
    close: async () => closeResponseBody(response.body),
    response,
    timeout,
    timeoutPromise,
    timeoutMs: options.timeoutMs,
  };
}

async function openPackageDownloadResponse(url: string, options: PackageDownloadOptions) {
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const timeoutMs = resolvePackageCandidateTimeoutMs(
    options.timeoutMs,
    PACKAGE_URL_DOWNLOAD_TIMEOUT_MS,
  );
  const maxRedirects = options.maxRedirects ?? PACKAGE_URL_MAX_REDIRECTS;
  const trustedSource = options.trustedSource;
  let parsed = new URL(url);
  const initialOrigin = parsed.origin;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (trustedSource) {
      validateTrustedPackageDownloadUrl(parsed, trustedSource, { isRedirect: redirectCount > 0 });
    } else {
      validatePackageDownloadUrl(parsed);
    }
    const addresses = await resolvePackageDownloadAddresses(parsed, lookupHost, trustedSource);
    const headers = createTrustedPackageAuthHeaders(trustedSource, parsed, initialOrigin);
    const opened = options.fetchImpl
      ? await openFetchPackageDownloadResponse(parsed, {
          fetchImpl: options.fetchImpl,
          headers,
          timeoutMs,
        })
      : await openHttpsPackageDownloadResponse(parsed, {
          addresses,
          headers,
          timeoutMs,
        });
    const status = responseStatus(opened.response);
    if ([301, 302, 303, 307, 308].includes(status)) {
      clearTimeout(opened.timeout);
      await opened.close();
      const location = responseHeader(opened.response, "location");
      if (!location) {
        throw new Error(`package_url redirect missing Location header: HTTP ${status}`);
      }
      parsed = new URL(location, parsed);
      continue;
    }
    return opened;
  }
  throw new Error(`package_url exceeded ${maxRedirects} redirects: ${url}`);
}

async function* limitWebResponseBody(
  body: WebResponseBody,
  maxBytes: number,
  timeoutPromise: Promise<never> | undefined,
): AsyncGenerator<string | Uint8Array> {
  let downloaded = 0;
  const reader = body.getReader();
  let timedOut = false;
  let timeoutFailure: unknown;
  const timeoutRead = timeoutPromise?.catch((error: unknown) => {
    timedOut = true;
    timeoutFailure = error;
    void reader.cancel().catch(() => {});
    throw error;
  });
  try {
    for (;;) {
      const next = reader.read();
      const { done, value } = timeoutRead ? await Promise.race([next, timeoutRead]) : await next;
      if (timedOut) {
        throw toErrorObject(timeoutFailure, "package_url download timed out");
      }
      if (done) {
        return;
      }
      const size = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      downloaded += size;
      if (downloaded > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`package_url exceeds maximum download size of ${maxBytes} bytes`);
      }
      yield value;
    }
  } finally {
    if (!timedOut) {
      reader.releaseLock();
    }
  }
}

async function* limitResponseBody(
  body: PackageResponseBody,
  maxBytes: number,
  timeoutPromise: Promise<never> | undefined,
): AsyncGenerator<string | Uint8Array> {
  if (isWebResponseBody(body)) {
    yield* limitWebResponseBody(body, maxBytes, timeoutPromise);
    return;
  }
  let downloaded = 0;
  for await (const chunk of body as AsyncIterable<string | Uint8Array>) {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    downloaded += size;
    if (downloaded > maxBytes) {
      throw new Error(`package_url exceeds maximum download size of ${maxBytes} bytes`);
    }
    yield chunk;
  }
}

export async function downloadUrl(
  urlText: string,
  targetPath: string,
  typedOptions: PackageDownloadOptions = {},
) {
  const maxBytes = typedOptions.maxBytes ?? PACKAGE_URL_MAX_BYTES;
  const { close, response, timeout, timeoutMs, timeoutPromise } = await openPackageDownloadResponse(
    urlText,
    typedOptions,
  );
  const tempTarget = `${targetPath}.tmp`;
  let waitForOutputClose: (() => Promise<void>) | undefined;
  try {
    if (!responseOk(response) || !response.body) {
      throw new Error(`failed to download package_url: HTTP ${responseStatus(response)}`);
    }
    const rawContentLength = responseHeader(response, "content-length");
    const contentLength =
      rawContentLength && /^\d+$/u.test(rawContentLength) ? Number(rawContentLength) : undefined;
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) || contentLength > maxBytes)
    ) {
      throw new Error(`package_url exceeds maximum download size of ${maxBytes} bytes`);
    }
    await fs.rm(tempTarget, { force: true });
    const output = createWriteStream(tempTarget);
    waitForOutputClose = async () => {
      if (!output.closed) {
        await once(output, "close").catch(() => {});
      }
    };
    await pipeline(limitResponseBody(response.body, maxBytes, timeoutPromise), output);
    await fs.rename(tempTarget, targetPath);
  } catch (error) {
    if (errorCode(error) === "ETIMEDOUT") {
      throw error;
    }
    if (errorName(error) === "AbortError") {
      throw new Error(`package_url download timed out after ${timeoutMs}ms: ${urlText}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await close();
    await waitForOutputClose?.();
    await fs.rm(tempTarget, { force: true });
  }
}

async function readPackageJson(tarball: string) {
  const raw = await run("tar", ["-xOf", tarball, "package/package.json"], { capture: true });
  const pkg: unknown = JSON.parse(raw);
  return {
    name: isJsonRecord(pkg) && typeof pkg.name === "string" ? pkg.name : "",
    version: isJsonRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "",
  };
}

export async function readPackageBuildSourceSha(tarball: string) {
  const raw = await run("tar", ["-xOf", tarball, "package/dist/build-info.json"], {
    capture: true,
  }).then(
    (value) => value,
    () => "",
  );
  if (!raw.trim()) {
    return "";
  }
  const buildInfo: unknown = JSON.parse(raw);
  const commit =
    isJsonRecord(buildInfo) && typeof buildInfo.commit === "string" ? buildInfo.commit.trim() : "";
  return /^[0-9a-f]{40}$/iu.test(commit) ? commit.toLowerCase() : "";
}

async function appendGithubOutputs(file: string, outputs: Record<string, unknown>) {
  if (!file) {
    return;
  }
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/gu, " ")}`)
    .join("\n");
  await fs.appendFile(file, `${body}\n`);
}

async function resolveCandidate(options: PackageCandidateOptions) {
  const outputDir = path.resolve(ROOT_DIR, options.outputDir);
  const target = path.join(outputDir, options.outputName || DEFAULT_OUTPUT_NAME);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(target, { force: true });
  let packageRef = "";
  let packageSourceSha = "";
  let packageTrustedReason = "";
  let packageTrustedSourceId = "";
  let packageWorktreeDir = "";
  let pluginRegistrySource: Awaited<ReturnType<typeof preparePackageSourceWorktree>> | undefined;
  let artifactMetadata: ArtifactMetadata = {};
  let pluginRegistryIdentity:
    | { candidateVersion: string; manifestSha256: string; sourceSha: string }
    | undefined;
  let resolveError: unknown;

  try {
    if (options.source === "ref") {
      packageRef = options.packageRef || "main";
      const packageSource = await preparePackageSourceWorktree(packageRef);
      packageWorktreeDir = packageSource.sourceDir;
      if (options.pluginRegistryOutputDir) {
        pluginRegistrySource = packageSource;
      }
      packageSourceSha = packageSource.selectedSha;
      packageTrustedReason = packageSource.trustedReason;
      await installPackageSourceDeps(packageSource.sourceDir);
      await run("node", [
        "scripts/package-openclaw-for-docker.mjs",
        "--allow-unreleased-changelog",
        "--source-dir",
        packageSource.sourceDir,
        "--output-dir",
        outputDir,
        "--output-name",
        options.outputName || DEFAULT_OUTPUT_NAME,
      ]);
    } else if (options.source === "npm") {
      const npmPackRunner = resolveNpmPackageCandidatePackRunner(options.packageSpec, outputDir, {
        env: process.env,
      });
      await cleanPackedOpenClawTarballs(outputDir);
      const packOutput = await run(npmPackRunner.command, npmPackRunner.args, {
        capture: true,
        env: npmPackRunner.env,
        shell: npmPackRunner.shell,
        windowsVerbatimArguments: npmPackRunner.windowsVerbatimArguments,
      });
      await moveNewestPackedTarball(
        outputDir,
        packOutput,
        options.outputName || DEFAULT_OUTPUT_NAME,
      );
      if (options.pluginRegistryOutputDir) {
        pluginRegistrySource = await preparePackageSourceWorktree(options.packageRef);
        packageWorktreeDir = pluginRegistrySource.sourceDir;
        packageRef = options.packageRef;
        await installPackageSourceDeps(pluginRegistrySource.sourceDir);
      }
    } else if (options.source === "url" || options.source === "trusted-url") {
      if (!options.packageUrl) {
        throw new Error(`${options.source} requires --package-url`);
      }
      if (!options.packageSha256) {
        throw new Error(`${options.source} requires --package-sha256`);
      }
      if (options.source === "trusted-url") {
        const trustedSource = await loadTrustedPackageSource(
          options.trustedSourceId,
          options.trustedSourcePolicy,
        );
        await downloadUrl(options.packageUrl, target, { trustedSource });
        packageTrustedReason = `trusted-url-policy:${trustedSource.id}`;
        packageTrustedSourceId = trustedSource.id;
      } else {
        if (options.trustedSourceId) {
          throw new Error("--trusted-source-id is only allowed with source=trusted-url");
        }
        await downloadUrl(options.packageUrl, target);
      }
    } else if (options.source === "artifact") {
      if (!options.artifactDir) {
        throw new Error("source=artifact requires --artifact-dir");
      }
      artifactMetadata = await readArtifactPackageCandidateMetadata(options.artifactDir);
      packageRef =
        typeof artifactMetadata.packageRef === "string" ? artifactMetadata.packageRef : "";
      packageSourceSha =
        typeof artifactMetadata.packageSourceSha === "string"
          ? artifactMetadata.packageSourceSha
          : "";
      packageTrustedReason =
        typeof artifactMetadata.packageTrustedReason === "string"
          ? artifactMetadata.packageTrustedReason
          : "";
      const input = await findSingleTarball(options.artifactDir);
      await fs.copyFile(input, target);
    } else {
      throw new Error(
        `source must be one of: ref, npm, url, trusted-url, artifact. Got: ${options.source}`,
      );
    }
    if (options.pluginRegistryOutputDir && !pluginRegistrySource) {
      throw new Error(
        "--plugin-registry-output-dir is only supported with source=ref or source=npm",
      );
    }
    if (options.pluginRegistryOutputDir && pluginRegistrySource) {
      const requiredPackages = JSON.parse(options.requiredPluginPackagesJson) as string[];
      const rootPackage = JSON.parse(
        await fs.readFile(path.join(pluginRegistrySource.sourceDir, "package.json"), "utf8"),
      ) as { version: string };
      const registry = createPrepublishPluginRegistryArtifact({
        repoRoot: pluginRegistrySource.sourceDir,
        outputDir: path.resolve(ROOT_DIR, options.pluginRegistryOutputDir),
        sourceSha: pluginRegistrySource.selectedSha,
        candidateVersion: rootPackage.version,
        requiredPackages,
      });
      pluginRegistryIdentity = {
        candidateVersion: rootPackage.version,
        manifestSha256: registry.manifestSha256,
        sourceSha: pluginRegistrySource.selectedSha,
      };
    }
  } catch (error) {
    resolveError = error;
    throw error;
  } finally {
    if (packageWorktreeDir) {
      await cleanupPackageSourceWorktree(packageWorktreeDir, { resolveError });
    }
  }

  const artifactSha256 = typeof artifactMetadata.sha256 === "string" ? artifactMetadata.sha256 : "";
  const digest = await assertExpectedSha256(target, options.packageSha256 || artifactSha256);
  console.error(`Checking OpenClaw package tarball: ${target}`);
  const checkStartedAt = Date.now();
  await run("node", ["scripts/check-openclaw-package-tarball.mjs", target], {
    timeoutMs: 5 * 60 * 1000,
  });
  console.error(
    `OpenClaw package tarball check finished in ${Math.round((Date.now() - checkStartedAt) / 1000)}s`,
  );
  const pkg = await readPackageJson(target);
  if (!packageSourceSha) {
    packageSourceSha = await readPackageBuildSourceSha(target);
    if (packageSourceSha && !packageTrustedReason) {
      packageTrustedReason = "package-build-info";
    }
  }
  if (
    pluginRegistryIdentity &&
    (pluginRegistryIdentity.candidateVersion !== pkg.version ||
      pluginRegistryIdentity.sourceSha !== packageSourceSha)
  ) {
    throw new Error(
      "prepublish plugin registry source SHA/version differs from the package candidate",
    );
  }
  const metadata = {
    name: pkg.name,
    packageRef,
    packageSpec: options.packageSpec || "",
    packageSourceSha,
    packageTrustedReason,
    pluginRegistryManifestSha256: pluginRegistryIdentity?.manifestSha256 ?? "",
    trustedSourceId: packageTrustedSourceId,
    sha256: digest,
    source: options.source,
    tarball: path.relative(ROOT_DIR, target),
    version: pkg.version,
  };

  if (pkg.name !== "openclaw") {
    throw new Error(`package candidate must be named "openclaw"; got: ${pkg.name || "<missing>"}`);
  }
  if (!pkg.version) {
    throw new Error("package candidate package.json has no version");
  }

  if (options.metadata) {
    await fs.mkdir(path.dirname(path.resolve(ROOT_DIR, options.metadata)), { recursive: true });
    await fs.writeFile(
      path.resolve(ROOT_DIR, options.metadata),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }
  await appendGithubOutputs(options.githubOutput, {
    package_name: pkg.name,
    package_source_sha: packageSourceSha,
    package_version: pkg.version,
    plugin_registry_manifest_sha256: pluginRegistryIdentity?.manifestSha256 ?? "",
    sha256: digest,
    tarball: metadata.tarball,
  });
  return metadata;
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.outputDir) {
    throw new Error("--output-dir is required");
  }
  const metadata = await resolveCandidate(options);
  console.log(JSON.stringify(metadata, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  });
}

function errorCode(value: unknown) {
  return isPropertyContainer(value) ? value.code : undefined;
}

function errorName(value: unknown) {
  return isPropertyContainer(value) ? value.name : undefined;
}

function isPropertyContainer(value: unknown): value is { code?: unknown; name?: unknown } {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isWebResponseBody(body: PackageResponseBody): body is WebResponseBody {
  return "getReader" in body && typeof body.getReader === "function";
}
