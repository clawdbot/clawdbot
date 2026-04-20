import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { QaProviderMode } from "./model-selection.js";
import { resolveQaForwardedLiveEnv, resolveQaLiveProviderConfigPath } from "./providers/env.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, getQaProvider } from "./providers/index.js";

const MULTIPASS_MOUNTED_REPO_PATH = "/workspace/openclaw-host";
const MULTIPASS_GUEST_REPO_PATH = "/workspace/openclaw";
const MULTIPASS_GUEST_CODEX_HOME_PATH = "/workspace/openclaw-codex-home";
const MULTIPASS_GUEST_PACKAGES = [
  "build-essential",
  "ca-certificates",
  "curl",
  "pkg-config",
  "python3",
  "rsync",
  "xz-utils",
] as const;
const MULTIPASS_REPO_SYNC_EXCLUDES = [
  ".git",
  "node_modules",
  ".artifacts",
  ".tmp",
  ".turbo",
  "coverage",
  "*.heapsnapshot",
] as const;
const MULTIPASS_EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const MULTIPASS_GUEST_RUN_TIMEOUT_MS = 60 * 60 * 1000;

export const qaMultipassDefaultResources = {
  image: "lts",
  cpus: 2,
  memory: "4G",
  disk: "24G",
} as const;

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ExecFileError = Error & {
  code?: string;
};

type ExecFileOptions = {
  timeoutMs?: number;
};

export type QaMultipassPlan = {
  repoRoot: string;
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  hostLogPath: string;
  hostBootstrapLogPath: string;
  hostGuestScriptPath: string;
  vmName: string;
  image: string;
  cpus: number;
  memory: string;
  disk: string;
  pnpmVersion: string;
  transportId: string;
  providerMode: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds: string[];
  forwardedEnv: Record<string, string>;
  hostCodexHomePath?: string;
  guestCodexHomePath?: string;
  hostLiveProviderConfigPath?: string;
  guestLiveProviderConfigPath?: string;
  guestMountedRepoPath: string;
  guestRepoPath: string;
  guestOutputDir: string;
  guestScriptPath: string;
  guestBootstrapLogPath: string;
  qaCommand: string[];
};

export type QaMultipassRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  hostLogPath: string;
  bootstrapLogPath: string;
  guestScriptPath: string;
  vmName: string;
  scenarioIds: string[];
};

type RenderGuestScriptOptions = {
  redactSecrets?: boolean;
};

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createOutputStamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
}

function createVmSuffix() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file: string, args: string[], options: ExecFileOptions = {}) {
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: MULTIPASS_EXEC_MAX_BUFFER,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message;
          const wrappedError = new Error(message, { cause: error }) as ExecFileError;
          wrappedError.code = (error as NodeJS.ErrnoException).code;
          reject(wrappedError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function resolveRealPath(value: string) {
  return fs.realpathSync.native?.(value) ?? fs.realpathSync(value);
}

function resolveExistingPath(value: string) {
  let currentPath = value;
  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`unable to resolve existing path for ${value}`);
    }
    currentPath = parentPath;
  }
  return currentPath;
}

function isPathInside(parentPath: string, childPath: string) {
  const relativePath = path.relative(parentPath, childPath);
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function validatePnpmVersion(version: string) {
  if (!/^[0-9A-Za-z.+_-]+$/u.test(version)) {
    throw new Error(`unsupported pnpm version in packageManager: ${version}`);
  }
  return version;
}

function resolveMountedOutputPath(repoRoot: string, hostPath: string) {
  const relativePath = path.relative(repoRoot, hostPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || relativePath.length === 0) {
    throw new Error(
      `qa suite --runner multipass requires --output-dir to stay under the repo root (${repoRoot}), got ${hostPath}.`,
    );
  }

  const realRepoRoot = resolveRealPath(repoRoot);
  const existingHostPath = resolveExistingPath(hostPath);
  const realExistingHostPath = resolveRealPath(existingHostPath);
  if (!isPathInside(realRepoRoot, realExistingHostPath) && realExistingHostPath !== realRepoRoot) {
    throw new Error(
      `qa suite --runner multipass requires --output-dir to stay under the repo root (${repoRoot}), got ${hostPath}.`,
    );
  }

  return path.posix.join(MULTIPASS_MOUNTED_REPO_PATH, ...relativePath.split(path.sep));
}

function resolvePnpmVersion(repoRoot: string) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    packageManager?: string;
  };
  const packageManager = packageJson.packageManager ?? "";
  const match = /^pnpm@(.+)$/.exec(packageManager);
  if (!match?.[1]) {
    throw new Error(`unable to resolve pnpm version from packageManager in ${packageJsonPath}`);
  }
  return match[1];
}

function resolveMultipassInstallHint() {
  if (process.platform === "darwin") {
    return "brew install --cask multipass";
  }
  if (process.platform === "win32") {
    return "winget install Canonical.Multipass";
  }
  if (process.platform === "linux") {
    return "sudo snap install multipass";
  }
  return "https://multipass.run/install";
}

function createQaMultipassOutputDir(repoRoot: string) {
  return path.join(repoRoot, ".artifacts", "qa-e2e", `multipass-${createOutputStamp()}`);
}

function resolveGuestMountedPath(repoRoot: string, hostPath: string) {
  return resolveMountedOutputPath(repoRoot, hostPath);
}

function appendScenarioArgs(command: string[], scenarioIds: string[]) {
  for (const scenarioId of scenarioIds) {
    command.push("--scenario", scenarioId);
  }
  return command;
}

export function createQaMultipassPlan(params: {
  repoRoot: string;
  outputDir?: string;
  transportId?: string;
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  allowFailures?: boolean;
  scenarioIds?: string[];
  concurrency?: number;
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
}) {
  const outputDir = params.outputDir ?? createQaMultipassOutputDir(params.repoRoot);
  const scenarioIds = [...new Set(params.scenarioIds ?? [])];
  const transportId = params.transportId?.trim() || "qa-channel";
  const providerMode = params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE;
  const provider = getQaProvider(providerMode);
  const forwardedEnv = provider.appliesLiveEnvAliases ? resolveQaForwardedLiveEnv() : {};
  const hostCodexHomePath = forwardedEnv.CODEX_HOME;
  const liveProviderConfig = provider.usesModelProviderPlugins
    ? resolveQaLiveProviderConfigPath()
    : undefined;
  const hostLiveProviderConfigPath =
    liveProviderConfig && fs.existsSync(liveProviderConfig.path)
      ? liveProviderConfig.path
      : undefined;
  const vmName = `openclaw-qa-${createVmSuffix()}`;
  const guestOutputDir = resolveGuestMountedPath(params.repoRoot, outputDir);
  const qaCommand = appendScenarioArgs(
    [
      "pnpm",
      "openclaw",
      "qa",
      "suite",
      "--transport",
      transportId,
      "--provider-mode",
      providerMode,
      "--output-dir",
      guestOutputDir,
      ...(params.primaryModel ? ["--model", params.primaryModel] : []),
      ...(params.alternateModel ? ["--alt-model", params.alternateModel] : []),
      ...(params.fastMode ? ["--fast"] : []),
      ...(params.allowFailures ? ["--allow-failures"] : []),
      ...(params.concurrency ? ["--concurrency", String(params.concurrency)] : []),
    ],
    scenarioIds,
  );

  return {
    repoRoot: params.repoRoot,
    outputDir,
    reportPath: path.join(outputDir, "qa-suite-report.md"),
    summaryPath: path.join(outputDir, "qa-suite-summary.json"),
    hostLogPath: path.join(outputDir, "multipass-host.log"),
    hostBootstrapLogPath: path.join(outputDir, "multipass-guest-bootstrap.log"),
    hostGuestScriptPath: path.join(outputDir, "multipass-guest-run.sh"),
    vmName,
    image: params.image ?? qaMultipassDefaultResources.image,
    cpus: params.cpus ?? qaMultipassDefaultResources.cpus,
    memory: params.memory ?? qaMultipassDefaultResources.memory,
    disk: params.disk ?? qaMultipassDefaultResources.disk,
    pnpmVersion: validatePnpmVersion(resolvePnpmVersion(params.repoRoot)),
    transportId,
    providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    scenarioIds,
    forwardedEnv,
    hostCodexHomePath,
    guestCodexHomePath: hostCodexHomePath ? MULTIPASS_GUEST_CODEX_HOME_PATH : undefined,
    hostLiveProviderConfigPath,
    guestLiveProviderConfigPath: hostLiveProviderConfigPath
      ? `/tmp/${vmName}-live-provider-config.json`
      : undefined,
    guestMountedRepoPath: MULTIPASS_MOUNTED_REPO_PATH,
    guestRepoPath: MULTIPASS_GUEST_REPO_PATH,
    guestOutputDir,
    guestScriptPath: `/tmp/${vmName}-qa-suite.sh`,
    guestBootstrapLogPath: `/tmp/${vmName}-bootstrap.log`,
    qaCommand,
  } satisfies QaMultipassPlan;
}

export function renderQaMultipassGuestScript(
  plan: QaMultipassPlan,
  options: RenderGuestScriptOptions = {},
) {
  const redactSecrets = options.redactSecrets ?? false;
  const rsyncCommand = [
    "rsync -a --delete",
    ...MULTIPASS_REPO_SYNC_EXCLUDES.flatMap((value) => ["--exclude", shellQuote(value)]),
    shellQuote(`${plan.guestMountedRepoPath}/`),
    shellQuote(`${plan.guestRepoPath}/`),
  ].join(" ");
  const qaCommand = [
    ...Object.entries(plan.forwardedEnv)
      .filter(
        ([key]) =>
          key !== "CODEX_HOME" &&
          key !== "OPENCLAW_CONFIG_PATH" &&
          key !== "OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH",
      )
      .map(([key, value]) => `${key}=${shellQuote(redactSecrets ? "<redacted>" : value)}`),
    ...(plan.guestCodexHomePath ? [`CODEX_HOME=${shellQuote(plan.guestCodexHomePath)}`] : []),
    ...(plan.guestLiveProviderConfigPath
      ? [
          `OPENCLAW_CONFIG_PATH=${shellQuote(plan.guestLiveProviderConfigPath)}`,
          `OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH=${shellQuote(plan.guestLiveProviderConfigPath)}`,
        ]
      : []),
    plan.qaCommand.map(shellQuote).join(" "),
  ].join(" ");

  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "trap 'status=$?; echo \"guest failure (exit ${status})\" >&2; exit ${status}' ERR",
    "",
    "export DEBIAN_FRONTEND=noninteractive",
    `BOOTSTRAP_LOG=${shellQuote(plan.guestBootstrapLogPath)}`,
    ': > "$BOOTSTRAP_LOG"',
    "",
    "ensure_guest_packages() {",
    '  sudo -E apt-get update >>"$BOOTSTRAP_LOG" 2>&1',
    "  sudo -E apt-get install -y \\",
    ...MULTIPASS_GUEST_PACKAGES.map((value, index) =>
      index === MULTIPASS_GUEST_PACKAGES.length - 1
        ? `    ${value} >>"$BOOTSTRAP_LOG" 2>&1`
        : `    ${value} \\`,
    ),
    "}",
    "",
    "ensure_node() {",
    "  if command -v node >/dev/null; then",
    "    local node_major",
    '    node_major="$(node -p \'process.versions.node.split(".")[0]\' 2>/dev/null || echo 0)"',
    '    if [ "${node_major}" -ge 22 ]; then',
    "      return 0",
    "    fi",
    "  fi",
    "  local node_arch",
    '  case "$(uname -m)" in',
    '    x86_64) node_arch="x64" ;;',
    '    aarch64|arm64) node_arch="arm64" ;;',
    '    *) echo "unsupported guest architecture for node bootstrap: $(uname -m)" >&2; return 1 ;;',
    "  esac",
    "  local node_tmp_dir tarball_name extract_dir base_url",
    '  node_tmp_dir="$(mktemp -d)"',
    "  trap 'rm -rf \"${node_tmp_dir}\"' RETURN",
    '  base_url="https://nodejs.org/dist/latest-v22.x"',
    '  curl -fsSL "${base_url}/SHASUMS256.txt" -o "${node_tmp_dir}/SHASUMS256.txt" >>"$BOOTSTRAP_LOG" 2>&1',
    '  tarball_name="$(awk \'/linux-\'"${node_arch}"\'\\.tar\\.xz$/ { print $2; exit }\' "${node_tmp_dir}/SHASUMS256.txt")"',
    '  [ -n "${tarball_name}" ] || { echo "unable to resolve node tarball for ${node_arch}" >&2; return 1; }',
    '  curl -fsSL "${base_url}/${tarball_name}" -o "${node_tmp_dir}/${tarball_name}" >>"$BOOTSTRAP_LOG" 2>&1',
    '  (cd "${node_tmp_dir}" && grep " ${tarball_name}$" SHASUMS256.txt | sha256sum -c -) >>"$BOOTSTRAP_LOG" 2>&1',
    '  extract_dir="${tarball_name%.tar.xz}"',
    '  sudo mkdir -p /usr/local/lib/nodejs >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo rm -rf "/usr/local/lib/nodejs/${extract_dir}" >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo tar -xJf "${node_tmp_dir}/${tarball_name}" -C /usr/local/lib/nodejs >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/node" /usr/local/bin/node >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/npm" /usr/local/bin/npm >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/npx" /usr/local/bin/npx >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/corepack" /usr/local/bin/corepack >>"$BOOTSTRAP_LOG" 2>&1',
    "}",
    "",
    "ensure_pnpm() {",
    '  sudo env PATH="/usr/local/bin:/usr/bin:/bin" corepack enable >>"$BOOTSTRAP_LOG" 2>&1',
    `  sudo env PATH="/usr/local/bin:/usr/bin:/bin" corepack prepare ${shellQuote(`pnpm@${plan.pnpmVersion}`)} --activate >>"$BOOTSTRAP_LOG" 2>&1`,
    "}",
    "",
    'command -v sudo >/dev/null || { echo "missing sudo in guest" >&2; exit 1; }',
    "ensure_guest_packages",
    "ensure_node",
    "ensure_pnpm",
    'command -v node >/dev/null || { echo "missing node after guest bootstrap" >&2; exit 1; }',
    'command -v pnpm >/dev/null || { echo "missing pnpm after guest bootstrap" >&2; exit 1; }',
    'command -v rsync >/dev/null || { echo "missing rsync after guest bootstrap" >&2; exit 1; }',
    "",
    `mkdir -p ${shellQuote(path.posix.dirname(plan.guestRepoPath))}`,
    `rm -rf ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(plan.guestOutputDir)}`,
    rsyncCommand,
    `cd ${shellQuote(plan.guestRepoPath)}`,
    'pnpm install --frozen-lockfile >>"$BOOTSTRAP_LOG" 2>&1',
    'pnpm build >>"$BOOTSTRAP_LOG" 2>&1',
    qaCommand,
    "",
  ];
  return lines.join("\n");
}

async function appendMultipassLog(logPath: string, message: string) {
  await appendFile(logPath, message, "utf8");
}

async function runMultipassCommand(logPath: string, args: string[], options: ExecFileOptions = {}) {
  await appendMultipassLog(logPath, `$ ${["multipass", ...args].join(" ")}\n`);
  const result = await execFileAsync("multipass", args, options);
  if (result.stdout.trim()) {
    await appendMultipassLog(logPath, `${result.stdout.trim()}\n`);
  }
  if (result.stderr.trim()) {
    await appendMultipassLog(logPath, `${result.stderr.trim()}\n`);
  }
  await appendMultipassLog(logPath, "\n");
  return result;
}

async function waitForGuestReady(logPath: string, vmName: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await runMultipassCommand(logPath, ["exec", vmName, "--", "bash", "-lc", "echo guest-ready"]);
      return;
    } catch (error) {
      lastError = error;
      await appendMultipassLog(
        logPath,
        `guest-ready retry ${attempt}/12: ${error instanceof Error ? error.message : String(error)}\n\n`,
      );
      if (attempt < 12) {
        await sleep(2_000);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mountRepo(logPath: string, repoRoot: string, vmName: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await runMultipassCommand(logPath, [
        "mount",
        repoRoot,
        `${vmName}:${MULTIPASS_MOUNTED_REPO_PATH}`,
      ]);
      return;
    } catch (error) {
      lastError = error;
      await appendMultipassLog(
        logPath,
        `mount retry ${attempt}/5: ${error instanceof Error ? error.message : String(error)}\n\n`,
      );
      if (attempt < 5) {
        await sleep(2_000);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mountCodexHome(logPath: string, hostCodexHomePath: string, vmName: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await runMultipassCommand(logPath, [
        "mount",
        hostCodexHomePath,
        `${vmName}:${MULTIPASS_GUEST_CODEX_HOME_PATH}`,
      ]);
      return;
    } catch (error) {
      lastError = error;
      await appendMultipassLog(
        logPath,
        `codex-home mount retry ${attempt}/5: ${error instanceof Error ? error.message : String(error)}\n\n`,
      );
      if (attempt < 5) {
        await sleep(2_000);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function transferLiveProviderConfig(plan: QaMultipassPlan) {
  if (!plan.hostLiveProviderConfigPath || !plan.guestLiveProviderConfigPath) {
    return;
  }
  await runMultipassCommand(plan.hostLogPath, [
    "transfer",
    plan.hostLiveProviderConfigPath,
    `${plan.vmName}:${plan.guestLiveProviderConfigPath}`,
  ]);
}

async function tryCopyGuestBootstrapLog(plan: QaMultipassPlan) {
  try {
    await runMultipassCommand(plan.hostLogPath, [
      "transfer",
      `${plan.vmName}:${plan.guestBootstrapLogPath}`,
      plan.hostBootstrapLogPath,
    ]);
  } catch (error) {
    await appendMultipassLog(
      plan.hostLogPath,
      `bootstrap log transfer skipped: ${error instanceof Error ? error.message : String(error)}\n\n`,
    );
  }
}

export async function runQaMultipass(params: {
  repoRoot: string;
  outputDir?: string;
  transportId?: string;
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  allowFailures?: boolean;
  scenarioIds?: string[];
  concurrency?: number;
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
}) {
  const plan = createQaMultipassPlan(params);
  await mkdir(plan.outputDir, { recursive: true });
  await writeFile(
    plan.hostLogPath,
    `# OpenClaw QA Multipass host log\nvmName=${plan.vmName}\noutputDir=${plan.outputDir}\n\n`,
    "utf8",
  );
  await writeFile(
    plan.hostGuestScriptPath,
    renderQaMultipassGuestScript(plan, { redactSecrets: true }),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  try {
    await execFileAsync("multipass", ["version"]);
  } catch (error) {
    if ((error as ExecFileError).code !== "ENOENT") {
      throw new Error(
        `Unable to verify Multipass availability: ${error instanceof Error ? error.message : String(error)}.`,
        { cause: error },
      );
    }
    throw new Error(
      `Multipass is not installed on this host. Install it with '${resolveMultipassInstallHint()}', then rerun 'pnpm openclaw qa suite --runner multipass'.`,
      { cause: error },
    );
  }

  const hostTransferDirPath = await fs.promises.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), `${plan.vmName}-qa-suite-`),
  );
  const hostTransferScriptPath = path.join(hostTransferDirPath, "guest-run.sh");
  await writeFile(hostTransferScriptPath, renderQaMultipassGuestScript(plan), {
    encoding: "utf8",
    mode: 0o600,
  });

  let launched = false;
  try {
    await runMultipassCommand(plan.hostLogPath, [
      "launch",
      "--name",
      plan.vmName,
      "--cpus",
      String(plan.cpus),
      "--memory",
      plan.memory,
      "--disk",
      plan.disk,
      plan.image,
    ]);
    launched = true;
    await waitForGuestReady(plan.hostLogPath, plan.vmName);
    await mountRepo(plan.hostLogPath, plan.repoRoot, plan.vmName);
    if (plan.hostCodexHomePath) {
      await mountCodexHome(plan.hostLogPath, plan.hostCodexHomePath, plan.vmName);
    }
    await transferLiveProviderConfig(plan);
    await runMultipassCommand(plan.hostLogPath, [
      "transfer",
      hostTransferScriptPath,
      `${plan.vmName}:${plan.guestScriptPath}`,
    ]);
    await runMultipassCommand(plan.hostLogPath, [
      "exec",
      plan.vmName,
      "--",
      "chmod",
      "+x",
      plan.guestScriptPath,
    ]);
    await runMultipassCommand(plan.hostLogPath, ["exec", plan.vmName, "--", plan.guestScriptPath], {
      timeoutMs: MULTIPASS_GUEST_RUN_TIMEOUT_MS,
    });
    await tryCopyGuestBootstrapLog(plan);
  } catch (error) {
    if (launched) {
      await tryCopyGuestBootstrapLog(plan);
    }
    throw new Error(
      `QA Multipass run failed: ${error instanceof Error ? error.message : String(error)}. See ${plan.hostLogPath}.`,
      { cause: error },
    );
  } finally {
    await fs.promises.rm(hostTransferDirPath, { recursive: true, force: true });
    if (launched) {
      try {
        await runMultipassCommand(plan.hostLogPath, ["delete", "--purge", plan.vmName]);
      } catch (error) {
        await appendMultipassLog(
          plan.hostLogPath,
          `cleanup error: ${error instanceof Error ? error.message : String(error)}\n\n`,
        );
      }
    }
  }

  await access(plan.reportPath);
  await access(plan.summaryPath);

  return {
    outputDir: plan.outputDir,
    reportPath: plan.reportPath,
    summaryPath: plan.summaryPath,
    hostLogPath: plan.hostLogPath,
    bootstrapLogPath: plan.hostBootstrapLogPath,
    guestScriptPath: plan.hostGuestScriptPath,
    vmName: plan.vmName,
    scenarioIds: plan.scenarioIds,
  } satisfies QaMultipassRunResult;
}
