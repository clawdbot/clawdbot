import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";

export type MantisSlackDesktopSmokeOptions = {
  alternateModel?: string;
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  credentialRole?: string;
  credentialSource?: string;
  env?: NodeJS.ProcessEnv;
  fastMode?: boolean;
  gatewaySetup?: boolean;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  now?: () => Date;
  outputDir?: string;
  primaryModel?: string;
  provider?: string;
  providerMode?: string;
  repoRoot?: string;
  scenarioIds?: string[];
  slackChannelId?: string;
  slackUrl?: string;
  ttl?: string;
};

export type MantisSlackDesktopSmokeResult = {
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

type MantisSlackDesktopSmokeSummary = {
  artifacts: {
    reportPath: string;
    screenshotPath?: string;
    slackQaDir?: string;
    summaryPath: string;
  };
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
  slackUrl?: string;
  startedAt: string;
  status: "pass" | "fail";
};

const DEFAULT_PROVIDER = "hetzner";
const DEFAULT_CLASS = "beast";
const DEFAULT_IDLE_TIMEOUT = "90m";
const DEFAULT_TTL = "180m";
const DEFAULT_CREDENTIAL_SOURCE = "env";
const DEFAULT_CREDENTIAL_ROLE = "maintainer";
const DEFAULT_PROVIDER_MODE = "live-frontier";
const DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_SLACK_CHANNEL_ID = "C0AUXUC5AGN";
const CRABBOX_BIN_ENV = "OPENCLAW_MANTIS_CRABBOX_BIN";
const CRABBOX_PROVIDER_ENV = "OPENCLAW_MANTIS_CRABBOX_PROVIDER";
const CRABBOX_CLASS_ENV = "OPENCLAW_MANTIS_CRABBOX_CLASS";
const CRABBOX_LEASE_ID_ENV = "OPENCLAW_MANTIS_CRABBOX_LEASE_ID";
const CRABBOX_KEEP_ENV = "OPENCLAW_MANTIS_KEEP_VM";
const CRABBOX_IDLE_TIMEOUT_ENV = "OPENCLAW_MANTIS_CRABBOX_IDLE_TIMEOUT";
const CRABBOX_TTL_ENV = "OPENCLAW_MANTIS_CRABBOX_TTL";
const SLACK_URL_ENV = "OPENCLAW_MANTIS_SLACK_URL";
const SLACK_CHANNEL_ID_ENV = "OPENCLAW_MANTIS_SLACK_CHANNEL_ID";

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
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `slack-desktop-${stamp}`);
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

function buildCrabboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = {
    ...env,
  };
  if (!trimToValue(next.OPENCLAW_LIVE_OPENAI_KEY) && trimToValue(next.OPENAI_API_KEY)) {
    next.OPENCLAW_LIVE_OPENAI_KEY = next.OPENAI_API_KEY;
  }
  if (!trimToValue(next.OPENCLAW_MANTIS_SLACK_BOT_TOKEN) && trimToValue(next.SLACK_BOT_TOKEN)) {
    next.OPENCLAW_MANTIS_SLACK_BOT_TOKEN = next.SLACK_BOT_TOKEN;
  }
  if (!trimToValue(next.OPENCLAW_MANTIS_SLACK_APP_TOKEN) && trimToValue(next.SLACK_APP_TOKEN)) {
    next.OPENCLAW_MANTIS_SLACK_APP_TOKEN = next.SLACK_APP_TOKEN;
  }
  return next;
}

function extractLeaseId(output: string) {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderRemoteScript(params: {
  alternateModel: string;
  credentialRole: string;
  credentialSource: string;
  fastMode: boolean;
  primaryModel: string;
  providerMode: string;
  remoteOutputDir: string;
  scenarioIds: readonly string[];
  setupGateway: boolean;
  slackChannelId: string;
  slackUrl?: string;
}) {
  const shellOutputDir = shellQuote(params.remoteOutputDir);
  const slackUrl = shellQuote(params.slackUrl ?? "");
  const credentialSource = shellQuote(params.credentialSource);
  const credentialRole = shellQuote(params.credentialRole);
  const providerMode = shellQuote(params.providerMode);
  const primaryModel = shellQuote(params.primaryModel);
  const alternateModel = shellQuote(params.alternateModel);
  const fastMode = params.fastMode ? "1" : "0";
  const setupGateway = params.setupGateway ? "1" : "0";
  const slackChannelId = shellQuote(params.slackChannelId);
  const scenarioArgs = params.scenarioIds.flatMap((id) => ["--scenario", shellQuote(id)]).join(" ");
  return `set -euo pipefail
out=${shellOutputDir}
slack_url_override=${slackUrl}
credential_source=${credentialSource}
credential_role=${credentialRole}
provider_mode=${providerMode}
primary_model=${primaryModel}
alternate_model=${alternateModel}
fast_mode=${fastMode}
setup_gateway=${setupGateway}
slack_channel_id=${slackChannelId}
rm -rf "$out"
mkdir -p "$out"
export DISPLAY="\${DISPLAY:-:99}"
if [ -n "\${OPENCLAW_LIVE_OPENAI_KEY:-}" ] && [ -z "\${OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY="$OPENCLAW_LIVE_OPENAI_KEY"
fi
if ! command -v node >/dev/null 2>&1; then
  sudo apt-get update -y >"$out/node-apt.log" 2>&1
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >>"$out/node-apt.log" 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >>"$out/node-apt.log" 2>&1
fi
if ! command -v scrot >/dev/null 2>&1; then
  sudo apt-get update -y >"$out/apt.log" 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y scrot >>"$out/apt.log" 2>&1
fi
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
team_id="\${OPENCLAW_QA_SLACK_TEAM_ID:-}"
auth_test_token="\${OPENCLAW_QA_SLACK_SUT_BOT_TOKEN:-\${OPENCLAW_MANTIS_SLACK_BOT_TOKEN:-}}"
if [ -z "$slack_url_override" ] && [ -z "$team_id" ] && [ -n "$auth_test_token" ]; then
  node --input-type=module >"$out/slack-auth-test.json" 2>"$out/slack-auth-test.err" <<'MANTIS_SLACK_AUTH'
const token = process.env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN || process.env.OPENCLAW_MANTIS_SLACK_BOT_TOKEN;
const response = await fetch("https://slack.com/api/auth.test", {
  method: "POST",
  headers: { authorization: \`Bearer \${token}\` },
});
const body = await response.json();
process.stdout.write(JSON.stringify({ ok: body.ok, team_id: body.team_id, user_id: body.user_id }));
if (!body.ok) process.exit(1);
MANTIS_SLACK_AUTH
  team_id="$(node --input-type=module -e 'import fs from "node:fs"; const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.team_id || "");' "$out/slack-auth-test.json" || true)"
fi
slack_url="$slack_url_override"
if [ -z "$slack_url" ] && [ -n "$team_id" ] && [ -n "\${OPENCLAW_QA_SLACK_CHANNEL_ID:-}" ]; then
  slack_url="https://app.slack.com/client/$team_id/$OPENCLAW_QA_SLACK_CHANNEL_ID"
fi
profile="\${OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR:-$HOME/.config/openclaw-mantis/slack-chrome-profile}"
mkdir -p "$profile"
if [ "$setup_gateway" = "1" ]; then
  export SLACK_BOT_TOKEN="\${OPENCLAW_MANTIS_SLACK_BOT_TOKEN:-\${SLACK_BOT_TOKEN:-}}"
  export SLACK_APP_TOKEN="\${OPENCLAW_MANTIS_SLACK_APP_TOKEN:-\${SLACK_APP_TOKEN:-}}"
  if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_APP_TOKEN" ]; then
    echo "Gateway setup requires OPENCLAW_MANTIS_SLACK_BOT_TOKEN and OPENCLAW_MANTIS_SLACK_APP_TOKEN." >&2
    exit 2
  fi
  if [ -z "$slack_url" ] && [ -n "$team_id" ]; then
    slack_url="https://app.slack.com/client/$team_id/$slack_channel_id"
  fi
fi
if [ -z "$slack_url" ]; then
  slack_url="https://app.slack.com/client"
fi
if [ "$setup_gateway" = "1" ]; then
  nohup "$browser_bin" \
    --user-data-dir="$profile" \
    --no-first-run \
    --no-default-browser-check \
    --disable-dev-shm-usage \
    --window-size=1440,1000 \
    --window-position=0,0 \
    --class=mantis-slack-desktop-smoke \
    "$slack_url" >"$out/chrome.log" 2>&1 &
else
  "$browser_bin" \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --window-size=1440,1000 \
  --window-position=0,0 \
  --class=mantis-slack-desktop-smoke \
  "$slack_url" >"$out/chrome.log" 2>&1 &
fi
chrome_pid=$!
qa_status=0
{
  set -e
  echo "remote pwd: $(pwd)"
  sudo corepack enable || sudo npm install -g pnpm@10.33.2
  pnpm install --frozen-lockfile
  pnpm build
  if [ "$setup_gateway" = "1" ]; then
    export OPENCLAW_HOME="$HOME/.openclaw-mantis/slack-openclaw"
    mkdir -p "$OPENCLAW_HOME"
    cat >"$out/slack.socket.patch.json5" <<MANTIS_SLACK_PATCH
{
  gateway: {
    port: 38973,
    auth: { mode: "none" },
  },
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      webhookPath: "/slack/events",
      userTokenReadOnly: true,
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      groupPolicy: "allowlist",
      channels: {
        "$slack_channel_id": {
          enabled: true,
          requireMention: true,
          allowBots: true,
          users: ["*"],
        },
      },
    },
  },
}
MANTIS_SLACK_PATCH
    pnpm openclaw config patch --file "$out/slack.socket.patch.json5" --dry-run
    pnpm openclaw config patch --file "$out/slack.socket.patch.json5"
    nohup pnpm openclaw gateway run --dev --allow-unconfigured --port 38973 --cli-backend-logs >"$out/openclaw-gateway.log" 2>&1 &
    echo "$!" >"$out/openclaw-gateway.pid"
    sleep 12
  else
    qa_args=(openclaw qa slack --repo-root . --output-dir "$out/slack-qa" --provider-mode "$provider_mode" --model "$primary_model" --alt-model "$alternate_model" --credential-source "$credential_source" --credential-role "$credential_role")
    if [ "$fast_mode" = "1" ]; then
      qa_args+=(--fast)
    fi
    pnpm "\${qa_args[@]}" ${scenarioArgs}
  fi
} >"$out/slack-desktop-command.log" 2>&1 || qa_status=$?
sleep 5
scrot "$out/slack-desktop-smoke.png" || true
if [ "$setup_gateway" != "1" ]; then
  kill "$chrome_pid" >/dev/null 2>&1 || true
fi
cat >"$out/remote-metadata.json" <<MANTIS_REMOTE_METADATA
{
  "browserBinary": "$browser_bin",
  "browserProfile": "$profile",
  "display": "$DISPLAY",
  "openedUrl": "$slack_url",
  "gatewaySetup": $setup_gateway,
  "gatewayPort": 38973,
  "qaExitCode": $qa_status,
  "credentialSource": "$credential_source",
  "credentialRole": "$credential_role",
  "providerMode": "$provider_mode",
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANTIS_REMOTE_METADATA
test -s "$out/slack-desktop-smoke.png"
exit "$qa_status"
`;
}

function renderReport(summary: MantisSlackDesktopSmokeSummary) {
  const lines = [
    "# Mantis Slack Desktop Smoke",
    "",
    `Status: ${summary.status}`,
    summary.slackUrl ? `Slack URL: ${summary.slackUrl}` : undefined,
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
    summary.artifacts.slackQaDir ? "- Slack QA artifacts: `slack-qa/`" : undefined,
    "- Remote metadata: `remote-metadata.json`",
    "- Remote command log: `slack-desktop-command.log`",
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

function sshCommand(params: { inspect: CrabboxInspect }) {
  const { host, sshKey, sshPort, sshUser } = params.inspect;
  if (!host || !sshKey || !sshUser) {
    throw new Error("Crabbox inspect output is missing SSH copy details.");
  }
  return {
    host,
    sshUser,
    sshArgs: [
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
  };
}

async function copyRemoteArtifacts(params: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  inspect: CrabboxInspect;
  outputDir: string;
  remoteOutputDir: string;
  runner: CommandRunner;
}) {
  const { host, sshArgs, sshUser } = sshCommand({ inspect: params.inspect });
  await fs.mkdir(path.join(params.outputDir, "slack-qa"), { recursive: true });
  await runCommand({
    command: "rsync",
    args: [
      "-az",
      "-e",
      sshArgs,
      `${sshUser}@${host}:${params.remoteOutputDir}/slack-desktop-smoke.png`,
      `${sshUser}@${host}:${params.remoteOutputDir}/remote-metadata.json`,
      `${sshUser}@${host}:${params.remoteOutputDir}/chrome.log`,
      `${sshUser}@${host}:${params.remoteOutputDir}/slack-desktop-command.log`,
      `${params.outputDir}/`,
    ],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
  });
  await runCommand({
    command: "rsync",
    args: [
      "-az",
      "-e",
      sshArgs,
      `${sshUser}@${host}:${params.remoteOutputDir}/slack-qa/`,
      `${path.join(params.outputDir, "slack-qa")}/`,
    ],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
  }).catch(() => ({ stdout: "", stderr: "" }));
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

export async function runMantisSlackDesktopSmoke(
  opts: MantisSlackDesktopSmokeOptions = {},
): Promise<MantisSlackDesktopSmokeResult> {
  const env = buildCrabboxEnv(opts.env ?? process.env);
  const startedAt = (opts.now ?? (() => new Date()))();
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ?? defaultOutputDir(repoRoot, startedAt),
    "Mantis Slack desktop smoke output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-slack-desktop-smoke-summary.json");
  const reportPath = path.join(outputDir, "mantis-slack-desktop-smoke-report.md");
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
  const credentialSource = trimToValue(opts.credentialSource) ?? DEFAULT_CREDENTIAL_SOURCE;
  const credentialRole = trimToValue(opts.credentialRole) ?? DEFAULT_CREDENTIAL_ROLE;
  const providerMode = trimToValue(opts.providerMode) ?? DEFAULT_PROVIDER_MODE;
  const primaryModel = trimToValue(opts.primaryModel) ?? DEFAULT_MODEL;
  const alternateModel = trimToValue(opts.alternateModel) ?? primaryModel;
  const fastMode = opts.fastMode ?? true;
  const gatewaySetup = opts.gatewaySetup ?? false;
  const scenarioIds = opts.scenarioIds ?? [];
  const slackChannelId =
    trimToValue(opts.slackChannelId) ??
    trimToValue(env[SLACK_CHANNEL_ID_ENV]) ??
    trimToValue(env.OPENCLAW_QA_SLACK_CHANNEL_ID) ??
    DEFAULT_SLACK_CHANNEL_ID;
  const slackUrl = trimToValue(opts.slackUrl) ?? trimToValue(env[SLACK_URL_ENV]);
  const runner = opts.commandRunner ?? defaultCommandRunner;
  const explicitLeaseId = trimToValue(opts.leaseId) ?? trimToValue(env[CRABBOX_LEASE_ID_ENV]);
  const keepLease = opts.keepLease ?? (gatewaySetup || isTruthyOptIn(env[CRABBOX_KEEP_ENV]));
  const createdLease = explicitLeaseId === undefined;
  const remoteOutputDir = `/tmp/openclaw-mantis-slack-desktop-${startedAt
    .toISOString()
    .replace(/[^0-9A-Za-z]/gu, "-")}`;
  let leaseId = explicitLeaseId;
  let summary: MantisSlackDesktopSmokeSummary | undefined;
  let screenshotPath: string | undefined;
  let slackQaDir: string | undefined;

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
    let remoteRunError: unknown;
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
        "--shell",
        "--",
        renderRemoteScript({
          alternateModel,
          credentialRole,
          credentialSource,
          fastMode,
          primaryModel,
          providerMode,
          remoteOutputDir,
          scenarioIds,
          setupGateway: gatewaySetup,
          slackChannelId,
          slackUrl,
        }),
      ],
      cwd: repoRoot,
      env,
      runner,
      stdio: "inherit",
    }).catch((error: unknown) => {
      remoteRunError = error;
      return { stdout: "", stderr: "" };
    });
    await copyRemoteArtifacts({
      cwd: repoRoot,
      env,
      inspect: inspected,
      outputDir,
      remoteOutputDir,
      runner,
    });
    screenshotPath = path.join(outputDir, "slack-desktop-smoke.png");
    slackQaDir = path.join(outputDir, "slack-qa");
    if (!(await pathExists(screenshotPath))) {
      throw new Error("Slack desktop screenshot was not copied back from Crabbox.");
    }
    if (remoteRunError) {
      throw remoteRunError;
    }
    summary = {
      artifacts: {
        reportPath,
        screenshotPath,
        slackQaDir,
        summaryPath,
      },
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
      slackUrl,
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
        screenshotPath,
        slackQaDir,
        summaryPath,
      },
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
      slackUrl,
      startedAt: startedAt.toISOString(),
      status: "fail",
    };
    await fs.writeFile(path.join(outputDir, "error.txt"), `${summary.error}\n`, "utf8");
    return {
      outputDir,
      reportPath,
      screenshotPath,
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
