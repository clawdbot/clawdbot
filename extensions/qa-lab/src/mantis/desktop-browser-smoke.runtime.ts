import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";

export type MantisDesktopBrowserSmokeOptions = {
  browserUrl?: string;
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  env?: NodeJS.ProcessEnv;
  htmlFile?: string;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  now?: () => Date;
  outputDir?: string;
  provider?: string;
  repoRoot?: string;
  ttl?: string;
};

export type MantisDesktopBrowserSmokeResult = {
  outputDir: string;
  reportPath: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
};

type CommandResult = {
  stderr: string;
  stdout: string;
};

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<CommandResult>;

type CrabboxInspect = {
  host?: string;
  id?: string;
  provider?: string;
  ready?: boolean;
  slug?: string;
  sshKey?: string;
  sshPort?: string;
  sshUser?: string;
  state?: string;
};

type MantisDesktopBrowserSmokeSummary = {
  artifacts: {
    reportPath: string;
    screenshotPath?: string;
    summaryPath: string;
  };
  browserUrl: string;
  htmlFile?: string;
  crabbox: {
    bin: string;
    createdLease: boolean;
    id: string;
    provider: string;
    slug?: string;
    state?: string;
    vncCommand: string;
  };
  error?: string;
  finishedAt: string;
  outputDir: string;
  remoteOutputDir: string;
  startedAt: string;
  status: "pass" | "fail";
};

const DEFAULT_BROWSER_URL = "https://openclaw.ai";
const DEFAULT_PROVIDER = "hetzner";
const DEFAULT_CLASS = "beast";
const DEFAULT_IDLE_TIMEOUT = "60m";
const DEFAULT_TTL = "120m";
const CRABBOX_BIN_ENV = "OPENCLAW_MANTIS_CRABBOX_BIN";
const CRABBOX_PROVIDER_ENV = "OPENCLAW_MANTIS_CRABBOX_PROVIDER";
const CRABBOX_CLASS_ENV = "OPENCLAW_MANTIS_CRABBOX_CLASS";
const CRABBOX_LEASE_ID_ENV = "OPENCLAW_MANTIS_CRABBOX_LEASE_ID";
const CRABBOX_KEEP_ENV = "OPENCLAW_MANTIS_KEEP_VM";
const CRABBOX_IDLE_TIMEOUT_ENV = "OPENCLAW_MANTIS_CRABBOX_IDLE_TIMEOUT";
const CRABBOX_TTL_ENV = "OPENCLAW_MANTIS_CRABBOX_TTL";

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function defaultOutputDir(repoRoot: string, startedAt: Date) {
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `desktop-browser-${stamp}`);
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.stdio === "inherit") {
        process.stdout.write(text);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.stdio === "inherit") {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}`));
    });
  });
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCrabboxBin(params: {
  env: NodeJS.ProcessEnv;
  explicit?: string;
  repoRoot: string;
}) {
  const configured = trimToValue(params.explicit) ?? trimToValue(params.env[CRABBOX_BIN_ENV]);
  if (configured) {
    return configured;
  }
  const sibling = path.resolve(params.repoRoot, "../crabbox/bin/crabbox");
  if (await pathExists(sibling)) {
    return sibling;
  }
  return "crabbox";
}

function extractLeaseId(output: string) {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveRepoBoundFile(repoRoot: string, filePath: string, label: string) {
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the repository: ${filePath}`);
  }
  return resolved;
}

function renderRemoteScript(params: {
  browserUrl: string;
  htmlBase64?: string;
  remoteOutputDir: string;
}) {
  const shellUrl = shellQuote(params.browserUrl);
  const shellUrlJson = shellQuote(JSON.stringify(params.browserUrl));
  const htmlBase64 = shellQuote(params.htmlBase64 ?? "");
  const shellOutputDir = shellQuote(params.remoteOutputDir);
  const inputModeJson = shellQuote(JSON.stringify(params.htmlBase64 ? "html-file" : "url"));
  const openedUrlJson = shellQuote(
    JSON.stringify(
      params.htmlBase64 ? `file://${params.remoteOutputDir}/input.html` : params.browserUrl,
    ),
  );
  return `set -euo pipefail
out=${shellOutputDir}
url=${shellUrl}
url_json=${shellUrlJson}
html_b64=${htmlBase64}
input_mode_json=${inputModeJson}
opened_url_json=${openedUrlJson}
rm -rf "$out"
mkdir -p "$out"
if [ -n "$html_b64" ]; then
  printf '%s' "$html_b64" | base64 -d >"$out/input.html"
  url="file://$out/input.html"
fi
export DISPLAY="\${DISPLAY:-:99}"
if ! command -v scrot >/dev/null 2>&1; then
  sudo apt-get update -y >"$out/apt.log" 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y scrot >>"$out/apt.log" 2>&1
fi
profile="$out/chrome-profile"
mkdir -p "$profile"
browser_bin=""
for candidate in "\${BROWSER:-}" "\${CHROME_BIN:-}" google-chrome chromium chromium-browser; do
  if [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1; then
    browser_bin="$(command -v "$candidate")"
    break
  fi
done
if [ -z "$browser_bin" ]; then
  echo "No browser binary found. Checked BROWSER, CHROME_BIN, google-chrome, chromium, chromium-browser." >&2
  exit 127
fi
"$browser_bin" \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --window-size=1280,900 \
  --window-position=0,0 \
  --class=mantis-desktop-browser-smoke \
  "$url" >"$out/chrome.log" 2>&1 &
chrome_pid=$!
cleanup() {
  kill "$chrome_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sleep 8
scrot "$out/desktop-browser-smoke.png"
cleanup
trap - EXIT
sleep 1
rm -rf "$profile" || true
cat >"$out/remote-metadata.json" <<MANTIS_REMOTE_METADATA
{
  "browserUrl": $url_json,
  "browserBinary": "$browser_bin",
  "display": "$DISPLAY",
  "chromePid": $chrome_pid,
  "inputMode": $input_mode_json,
  "openedUrl": $opened_url_json,
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANTIS_REMOTE_METADATA
test -s "$out/desktop-browser-smoke.png"
`;
}

function renderReport(summary: MantisDesktopBrowserSmokeSummary) {
  const lines = [
    "# Mantis Desktop Browser Smoke",
    "",
    `Status: ${summary.status}`,
    `Browser URL: ${summary.browserUrl}`,
    summary.htmlFile ? `HTML file: ${summary.htmlFile}` : undefined,
    `Output: ${summary.outputDir}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    "",
    "## Crabbox",
    "",
    `- Provider: ${summary.crabbox.provider}`,
    `- Lease: ${summary.crabbox.id}${summary.crabbox.slug ? ` (${summary.crabbox.slug})` : ""}`,
    `- Created by run: ${summary.crabbox.createdLease}`,
    `- State: ${summary.crabbox.state ?? "unknown"}`,
    `- VNC: \`${summary.crabbox.vncCommand}\``,
    "",
    "## Artifacts",
    "",
    summary.artifacts.screenshotPath
      ? `- Screenshot: \`${path.basename(summary.artifacts.screenshotPath)}\``
      : "- Screenshot: missing",
    "- Remote metadata: `remote-metadata.json`",
    "- Chrome log: `chrome.log`",
    summary.error ? `- Error: ${summary.error}` : undefined,
    "",
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}

async function runCommand(params: {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  stdio?: "inherit" | "pipe";
}) {
  return params.runner(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: params.stdio ?? "pipe",
  });
}

async function warmupCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  idleTimeout: string;
  machineClass: string;
  provider: string;
  runner: CommandRunner;
  ttl: string;
}) {
  const result = await runCommand({
    command: params.crabboxBin,
    args: [
      "warmup",
      "--provider",
      params.provider,
      "--desktop",
      "--browser",
      "--class",
      params.machineClass,
      "--idle-timeout",
      params.idleTimeout,
      "--ttl",
      params.ttl,
    ],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
    stdio: "inherit",
  });
  const leaseId = extractLeaseId(`${result.stdout}\n${result.stderr}`);
  if (!leaseId) {
    throw new Error("Crabbox warmup did not print a lease id.");
  }
  return leaseId;
}

async function inspectCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leaseId: string;
  provider: string;
  runner: CommandRunner;
}) {
  const result = await runCommand({
    command: params.crabboxBin,
    args: ["inspect", "--provider", params.provider, "--id", params.leaseId, "--json"],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
  });
  return JSON.parse(result.stdout) as CrabboxInspect;
}

async function copyRemoteArtifacts(params: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  inspect: CrabboxInspect;
  outputDir: string;
  remoteOutputDir: string;
  runner: CommandRunner;
}) {
  const { host, sshKey, sshPort, sshUser } = params.inspect;
  if (!host || !sshKey || !sshUser) {
    throw new Error("Crabbox inspect output is missing SSH copy details.");
  }
  await runCommand({
    command: "rsync",
    args: [
      "-az",
      "-e",
      [
        "ssh",
        "-i",
        shellQuote(sshKey),
        "-p",
        sshPort ?? "22",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
      ].join(" "),
      `${sshUser}@${host}:${params.remoteOutputDir}/desktop-browser-smoke.png`,
      `${sshUser}@${host}:${params.remoteOutputDir}/remote-metadata.json`,
      `${sshUser}@${host}:${params.remoteOutputDir}/chrome.log`,
      `${params.outputDir}/`,
    ],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
  });
}

async function stopCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leaseId: string;
  provider: string;
  runner: CommandRunner;
}) {
  await runCommand({
    command: params.crabboxBin,
    args: ["stop", "--provider", params.provider, params.leaseId],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
    stdio: "inherit",
  });
}

export async function runMantisDesktopBrowserSmoke(
  opts: MantisDesktopBrowserSmokeOptions = {},
): Promise<MantisDesktopBrowserSmokeResult> {
  const env = opts.env ?? process.env;
  const startedAt = (opts.now ?? (() => new Date()))();
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ?? defaultOutputDir(repoRoot, startedAt),
    "Mantis desktop browser smoke output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-desktop-browser-smoke-summary.json");
  const reportPath = path.join(outputDir, "mantis-desktop-browser-smoke-report.md");
  const crabboxBin = await resolveCrabboxBin({ env, explicit: opts.crabboxBin, repoRoot });
  const provider =
    trimToValue(opts.provider) ?? trimToValue(env[CRABBOX_PROVIDER_ENV]) ?? DEFAULT_PROVIDER;
  const machineClass =
    trimToValue(opts.machineClass) ?? trimToValue(env[CRABBOX_CLASS_ENV]) ?? DEFAULT_CLASS;
  const idleTimeout =
    trimToValue(opts.idleTimeout) ??
    trimToValue(env[CRABBOX_IDLE_TIMEOUT_ENV]) ??
    DEFAULT_IDLE_TIMEOUT;
  const ttl = trimToValue(opts.ttl) ?? trimToValue(env[CRABBOX_TTL_ENV]) ?? DEFAULT_TTL;
  const htmlFileOption = trimToValue(opts.htmlFile);
  const htmlFile = htmlFileOption
    ? resolveRepoBoundFile(repoRoot, htmlFileOption, "Mantis desktop HTML file")
    : undefined;
  const htmlBase64 = htmlFile
    ? Buffer.from(await fs.readFile(htmlFile)).toString("base64")
    : undefined;
  const browserUrl = htmlFile
    ? pathToFileURL(htmlFile).toString()
    : (trimToValue(opts.browserUrl) ?? DEFAULT_BROWSER_URL);
  const runner = opts.commandRunner ?? defaultCommandRunner;
  const explicitLeaseId = trimToValue(opts.leaseId) ?? trimToValue(env[CRABBOX_LEASE_ID_ENV]);
  const keepLease = opts.keepLease ?? isTruthyOptIn(env[CRABBOX_KEEP_ENV]);
  const createdLease = explicitLeaseId === undefined;
  const remoteOutputDir = `/tmp/openclaw-mantis-desktop-${startedAt
    .toISOString()
    .replace(/[^0-9A-Za-z]/gu, "-")}`;
  let leaseId = explicitLeaseId;
  let summary: MantisDesktopBrowserSmokeSummary | undefined;

  try {
    leaseId =
      leaseId ??
      (await warmupCrabbox({
        crabboxBin,
        cwd: repoRoot,
        env,
        idleTimeout,
        machineClass,
        provider,
        runner,
        ttl,
      }));
    const inspected = await inspectCrabbox({
      crabboxBin,
      cwd: repoRoot,
      env,
      leaseId,
      provider,
      runner,
    });
    await runCommand({
      command: crabboxBin,
      args: [
        "run",
        "--provider",
        provider,
        "--id",
        leaseId,
        "--desktop",
        "--browser",
        "--no-sync",
        "--shell",
        "--",
        renderRemoteScript({ browserUrl, htmlBase64, remoteOutputDir }),
      ],
      cwd: repoRoot,
      env,
      runner,
      stdio: "inherit",
    });
    await copyRemoteArtifacts({
      cwd: repoRoot,
      env,
      inspect: inspected,
      outputDir,
      remoteOutputDir,
      runner,
    });
    const screenshotPath = path.join(outputDir, "desktop-browser-smoke.png");
    if (!(await pathExists(screenshotPath))) {
      throw new Error("Desktop browser screenshot was not copied back from Crabbox.");
    }
    summary = {
      artifacts: {
        reportPath,
        screenshotPath,
        summaryPath,
      },
      browserUrl,
      htmlFile,
      crabbox: {
        bin: crabboxBin,
        createdLease,
        id: leaseId,
        provider,
        slug: inspected.slug,
        state: inspected.state,
        vncCommand: `${crabboxBin} vnc --provider ${provider} --id ${leaseId} --open`,
      },
      finishedAt: new Date().toISOString(),
      outputDir,
      remoteOutputDir,
      startedAt: startedAt.toISOString(),
      status: "pass",
    };
    return {
      outputDir,
      reportPath,
      screenshotPath,
      status: "pass",
      summaryPath,
    };
  } catch (error) {
    summary = {
      artifacts: {
        reportPath,
        summaryPath,
      },
      browserUrl,
      htmlFile,
      crabbox: {
        bin: crabboxBin,
        createdLease,
        id: leaseId ?? "unallocated",
        provider,
        vncCommand: leaseId
          ? `${crabboxBin} vnc --provider ${provider} --id ${leaseId} --open`
          : "unallocated",
      },
      error: formatErrorMessage(error),
      finishedAt: new Date().toISOString(),
      outputDir,
      remoteOutputDir,
      startedAt: startedAt.toISOString(),
      status: "fail",
    };
    await fs.writeFile(path.join(outputDir, "error.txt"), `${summary.error}\n`, "utf8");
    return {
      outputDir,
      reportPath,
      status: "fail",
      summaryPath,
    };
  } finally {
    if (summary) {
      summary.finishedAt = new Date().toISOString();
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await fs.writeFile(reportPath, renderReport(summary), "utf8");
    }
    if (summary?.status === "pass" && createdLease && leaseId && !keepLease) {
      await stopCrabbox({ crabboxBin, cwd: repoRoot, env, leaseId, provider, runner });
    }
  }
}
