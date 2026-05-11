import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../live-transports/shared/credential-lease.runtime.js";
import {
  type CommandRunner,
  type CrabboxInspect,
  defaultCommandRunner,
  inspectCrabbox,
  resolveCrabboxBin,
  runCommand,
  shellQuote,
  sshCommand,
  stopCrabbox,
  warmupCrabbox,
} from "./crabbox-runtime.js";

export type MantisSlackDesktopSmokeOptions = {
  alternateModel?: string;
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  credentialRole?: string;
  credentialSource?: string;
  env?: NodeJS.ProcessEnv;
  fastMode?: boolean;
  gatewaySetup?: boolean;
  hydrateMode?: MantisSlackDesktopHydrateMode;
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

export type MantisSlackDesktopHydrateMode = "prehydrated" | "source";

export type MantisSlackDesktopSmokeResult = {
  outputDir: string;
  reportPath: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
  videoPath?: string;
};

type SlackGatewayCredentialPayload = {
  channelId: string;
  sutAppToken: string;
  sutBotToken: string;
};

type SlackGatewayCredentialLease = Awaited<
  ReturnType<typeof acquireQaCredentialLease<SlackGatewayCredentialPayload>>
>;
type SlackGatewayCredentialHeartbeat = ReturnType<typeof startQaCredentialLeaseHeartbeat>;

type MantisSlackDesktopSmokeSummary = {
  artifacts: {
    reportPath: string;
    screenshotPath?: string;
    slackQaDir?: string;
    summaryPath: string;
    videoPath?: string;
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
  hydrateMode: MantisSlackDesktopHydrateMode;
  outputDir: string;
  remoteOutputDir: string;
  slackUrl?: string;
  startedAt: string;
  status: "pass" | "fail";
  timings: MantisPhaseTimings;
  warning?: string;
};

type MantisPhaseTiming = {
  durationMs: number;
  finishedAt: string;
  name: string;
  startedAt: string;
  status: "accepted" | "fail" | "pass";
};

type MantisPhaseTimings = {
  phases: MantisPhaseTiming[];
  totalMs: number;
};

type SlackDesktopRemoteMetadata = {
  gatewayAlive?: boolean;
  gatewayPid?: string;
  hydrateMode?: string;
  openedUrl?: string;
  qaExitCode?: number;
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
const DEFAULT_HYDRATE_MODE: MantisSlackDesktopHydrateMode = "source";
const CRABBOX_BIN_ENV = "OPENCLAW_MANTIS_CRABBOX_BIN";
const CRABBOX_PROVIDER_ENV = "OPENCLAW_MANTIS_CRABBOX_PROVIDER";
const CRABBOX_CLASS_ENV = "OPENCLAW_MANTIS_CRABBOX_CLASS";
const CRABBOX_LEASE_ID_ENV = "OPENCLAW_MANTIS_CRABBOX_LEASE_ID";
const CRABBOX_KEEP_ENV = "OPENCLAW_MANTIS_KEEP_VM";
const CRABBOX_IDLE_TIMEOUT_ENV = "OPENCLAW_MANTIS_CRABBOX_IDLE_TIMEOUT";
const CRABBOX_TTL_ENV = "OPENCLAW_MANTIS_CRABBOX_TTL";
const HYDRATE_MODE_ENV = "OPENCLAW_MANTIS_HYDRATE_MODE";
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

function normalizeHydrateMode(
  value: string | undefined,
): MantisSlackDesktopHydrateMode | undefined {
  const normalized = trimToValue(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "source" || normalized === "prehydrated") {
    return normalized;
  }
  throw new Error(`Unsupported Mantis Slack desktop hydrate mode: ${value}`);
}

function createPhaseTimer(startedAt: Date) {
  const phases: MantisPhaseTiming[] = [];
  const origin = startedAt.getTime();
  function recordPhase(name: string, phaseStarted: Date, status: MantisPhaseTiming["status"]) {
    const phaseFinished = new Date();
    phases.push({
      durationMs: phaseFinished.getTime() - phaseStarted.getTime(),
      finishedAt: phaseFinished.toISOString(),
      name,
      startedAt: phaseStarted.toISOString(),
      status,
    });
  }
  async function timePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
    const phaseStarted = new Date();
    try {
      const result = await run();
      recordPhase(name, phaseStarted, "pass");
      return result;
    } catch (error) {
      recordPhase(name, phaseStarted, "fail");
      throw error;
    }
  }
  function snapshot(now = new Date()): MantisPhaseTimings {
    return {
      phases: [...phases],
      totalMs: now.getTime() - origin,
    };
  }
  function updatePhaseStatus(name: string, status: MantisPhaseTiming["status"]) {
    const phase = phases.findLast((entry) => entry.name === name);
    if (phase) {
      phase.status = status;
    }
  }
  return { recordPhase, snapshot, timePhase, updatePhaseStatus };
}

function defaultOutputDir(repoRoot: string, startedAt: Date) {
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `slack-desktop-${stamp}`);
}

async function readRemoteMetadata(
  outputDir: string,
): Promise<SlackDesktopRemoteMetadata | undefined> {
  const metadataPath = path.join(outputDir, "remote-metadata.json");
  if (!(await pathExists(metadataPath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    return {
      gatewayAlive:
        typeof candidate.gatewayAlive === "boolean" ? candidate.gatewayAlive : undefined,
      gatewayPid: typeof candidate.gatewayPid === "string" ? candidate.gatewayPid : undefined,
      hydrateMode: typeof candidate.hydrateMode === "string" ? candidate.hydrateMode : undefined,
      openedUrl: typeof candidate.openedUrl === "string" ? candidate.openedUrl : undefined,
      qaExitCode: typeof candidate.qaExitCode === "number" ? candidate.qaExitCode : undefined,
    };
  } catch {
    return undefined;
  }
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
  if (
    !trimToValue(next.OPENCLAW_MANTIS_SLACK_BOT_TOKEN) &&
    trimToValue(next.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN)
  ) {
    next.OPENCLAW_MANTIS_SLACK_BOT_TOKEN = next.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN;
  }
  if (!trimToValue(next.OPENCLAW_MANTIS_SLACK_APP_TOKEN) && trimToValue(next.SLACK_APP_TOKEN)) {
    next.OPENCLAW_MANTIS_SLACK_APP_TOKEN = next.SLACK_APP_TOKEN;
  }
  if (
    !trimToValue(next.OPENCLAW_MANTIS_SLACK_APP_TOKEN) &&
    trimToValue(next.OPENCLAW_QA_SLACK_SUT_APP_TOKEN)
  ) {
    next.OPENCLAW_MANTIS_SLACK_APP_TOKEN = next.OPENCLAW_QA_SLACK_SUT_APP_TOKEN;
  }
  if (
    !trimToValue(next.OPENCLAW_MANTIS_SLACK_CHANNEL_ID) &&
    trimToValue(next.OPENCLAW_QA_SLACK_CHANNEL_ID)
  ) {
    next.OPENCLAW_MANTIS_SLACK_CHANNEL_ID = next.OPENCLAW_QA_SLACK_CHANNEL_ID;
  }
  return next;
}

function resolveSlackGatewayEnvPayload(env: NodeJS.ProcessEnv): SlackGatewayCredentialPayload {
  const channelId = trimToValue(env.OPENCLAW_QA_SLACK_CHANNEL_ID);
  const sutBotToken = trimToValue(env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN);
  const sutAppToken = trimToValue(env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN);
  if (!channelId || !sutBotToken || !sutAppToken) {
    throw new Error(
      "Gateway setup requires OPENCLAW_QA_SLACK_CHANNEL_ID, OPENCLAW_QA_SLACK_SUT_BOT_TOKEN, and OPENCLAW_QA_SLACK_SUT_APP_TOKEN when using --credential-source env.",
    );
  }
  return {
    channelId,
    sutAppToken,
    sutBotToken,
  };
}

function parseSlackGatewayCredentialPayload(payload: unknown): SlackGatewayCredentialPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Slack credential payload must be an object.");
  }
  const candidate = payload as Record<string, unknown>;
  const channelId =
    typeof candidate.channelId === "string" ? trimToValue(candidate.channelId) : undefined;
  const sutBotToken =
    typeof candidate.sutBotToken === "string" ? trimToValue(candidate.sutBotToken) : undefined;
  const sutAppToken =
    typeof candidate.sutAppToken === "string" ? trimToValue(candidate.sutAppToken) : undefined;
  if (!channelId || !sutBotToken || !sutAppToken) {
    throw new Error(
      "Slack credential payload must include channelId, sutBotToken, and sutAppToken.",
    );
  }
  return {
    channelId,
    sutAppToken,
    sutBotToken,
  };
}

async function prepareGatewayCredentialEnv(params: {
  credentialRole: string;
  credentialSource: string;
  env: NodeJS.ProcessEnv;
  gatewaySetup: boolean;
}) {
  if (!params.gatewaySetup) {
    return {};
  }
  if (
    trimToValue(params.env.OPENCLAW_MANTIS_SLACK_BOT_TOKEN) &&
    trimToValue(params.env.OPENCLAW_MANTIS_SLACK_APP_TOKEN)
  ) {
    return {};
  }
  const credentialLease = await acquireQaCredentialLease<SlackGatewayCredentialPayload>({
    env: params.env,
    kind: "slack",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveSlackGatewayEnvPayload(params.env),
    parsePayload: parseSlackGatewayCredentialPayload,
  });
  const leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const payload = credentialLease.payload;
  params.env.OPENCLAW_MANTIS_SLACK_BOT_TOKEN = payload.sutBotToken;
  params.env.OPENCLAW_MANTIS_SLACK_APP_TOKEN = payload.sutAppToken;
  params.env.OPENCLAW_MANTIS_SLACK_CHANNEL_ID =
    trimToValue(params.env.OPENCLAW_MANTIS_SLACK_CHANNEL_ID) ?? payload.channelId;
  params.env.OPENCLAW_QA_SLACK_CHANNEL_ID =
    trimToValue(params.env.OPENCLAW_QA_SLACK_CHANNEL_ID) ?? payload.channelId;
  params.env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN =
    trimToValue(params.env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN) ?? payload.sutBotToken;
  params.env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN =
    trimToValue(params.env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN) ?? payload.sutAppToken;
  return {
    credentialLease,
    leaseHeartbeat,
  };
}

function renderRemoteScript(params: {
  alternateModel: string;
  credentialRole: string;
  credentialSource: string;
  fastMode: boolean;
  hydrateMode: MantisSlackDesktopHydrateMode;
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
  const hydrateMode = shellQuote(params.hydrateMode);
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
hydrate_mode=${hydrateMode}
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
video_pid=""
if command -v ffmpeg >/dev/null 2>&1; then
  :
else
  sudo apt-get update -y >>"$out/apt.log" 2>&1 || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg >>"$out/apt.log" 2>&1 || true
fi
if command -v ffmpeg >/dev/null 2>&1; then
  display_input="$DISPLAY"
  case "$display_input" in
    *.*) ;;
    *) display_input="$display_input.0" ;;
  esac
  ffmpeg -hide_banner -loglevel error -y -f x11grab -framerate 15 -i "$display_input" -t 45 -pix_fmt yuv420p "$out/slack-desktop-smoke.mp4" >"$out/ffmpeg.log" 2>&1 &
  video_pid=$!
else
  echo "ffmpeg missing; video artifact skipped" >"$out/ffmpeg.log"
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
    "$slack_url" </dev/null >"$out/chrome.log" 2>&1 &
  disown "$!" >/dev/null 2>&1 || true
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
  sudo corepack enable || sudo npm install -g pnpm@11
  if [ "$hydrate_mode" = "source" ]; then
    if ! command -v make >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
      sudo apt-get update -y >>"$out/apt.log" 2>&1 || true
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3 >>"$out/apt.log" 2>&1 || true
    fi
    if [ -d /var/cache/crabbox ]; then
      export PNPM_STORE_DIR="\${PNPM_STORE_DIR:-/var/cache/crabbox/pnpm}"
      mkdir -p "$PNPM_STORE_DIR" >/dev/null 2>&1 || true
      pnpm config set store-dir "$PNPM_STORE_DIR" >/dev/null 2>&1 || true
    fi
    pnpm install --frozen-lockfile --prefer-offline
    pnpm build
  elif [ "$hydrate_mode" = "prehydrated" ]; then
    test -d node_modules || {
      echo "hydrate-mode=prehydrated requires node_modules in the remote workspace." >&2
      exit 3
    }
    test -d dist || {
      echo "hydrate-mode=prehydrated requires a built dist/ directory in the remote workspace." >&2
      exit 3
    }
  else
    echo "Unsupported hydrate mode: $hydrate_mode" >&2
    exit 3
  fi
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
    nohup pnpm openclaw gateway run --dev --allow-unconfigured --port 38973 --cli-backend-logs </dev/null >"$out/openclaw-gateway.log" 2>&1 &
    gateway_pid="$!"
    echo "$gateway_pid" >"$out/openclaw-gateway.pid"
    sleep 12
    if ! kill -0 "$gateway_pid" >/dev/null 2>&1; then
      echo "OpenClaw gateway exited during startup." >&2
      wait "$gateway_pid" || true
      exit 1
    fi
    disown "$gateway_pid" >/dev/null 2>&1 || true
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
if [ -n "$video_pid" ]; then
  wait "$video_pid" || true
fi
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
  "gatewayAlive": $(if [ "$setup_gateway" = "1" ] && [ -f "$out/openclaw-gateway.pid" ] && kill -0 "$(cat "$out/openclaw-gateway.pid")" >/dev/null 2>&1; then echo true; else echo false; fi),
  "gatewayPid": "$(if [ -f "$out/openclaw-gateway.pid" ]; then cat "$out/openclaw-gateway.pid"; fi)",
  "gatewayPort": 38973,
  "qaExitCode": $qa_status,
  "credentialSource": "$credential_source",
  "credentialRole": "$credential_role",
  "providerMode": "$provider_mode",
  "hydrateMode": "$hydrate_mode",
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
    `- Hydrate mode: ${summary.hydrateMode}`,
    "",
    "## Timings",
    "",
    `- Total: ${Math.round(summary.timings.totalMs / 100) / 10}s`,
    ...summary.timings.phases.map(
      (phase) => `- ${phase.name}: ${Math.round(phase.durationMs / 100) / 10}s (${phase.status})`,
    ),
    "",
    "## Artifacts",
    "",
    summary.artifacts.screenshotPath
      ? `- Screenshot: \`${path.basename(summary.artifacts.screenshotPath)}\``
      : "- Screenshot: missing",
    summary.artifacts.videoPath
      ? `- Video: \`${path.basename(summary.artifacts.videoPath)}\``
      : "- Video: missing",
    summary.artifacts.slackQaDir ? "- Slack QA artifacts: `slack-qa/`" : undefined,
    "- Remote metadata: `remote-metadata.json`",
    "- Remote command log: `slack-desktop-command.log`",
    "- FFmpeg log: `ffmpeg.log`",
    "- Chrome log: `chrome.log`",
    summary.error ? `- Error: ${summary.error}` : undefined,
    "",
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
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
      `${sshUser}@${host}:${params.remoteOutputDir}/`,
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

export async function runMantisSlackDesktopSmoke(
  opts: MantisSlackDesktopSmokeOptions = {},
): Promise<MantisSlackDesktopSmokeResult> {
  const env = buildCrabboxEnv(opts.env ?? process.env);
  const startedAt = (opts.now ?? (() => new Date()))();
  const timer = createPhaseTimer(startedAt);
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ?? defaultOutputDir(repoRoot, startedAt),
    "Mantis Slack desktop smoke output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-slack-desktop-smoke-summary.json");
  const reportPath = path.join(outputDir, "mantis-slack-desktop-smoke-report.md");
  const crabboxBin = await resolveCrabboxBin({
    env,
    envName: CRABBOX_BIN_ENV,
    explicit: opts.crabboxBin,
    repoRoot,
  });
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
  const hydrateMode =
    normalizeHydrateMode(opts.hydrateMode) ??
    normalizeHydrateMode(env[HYDRATE_MODE_ENV]) ??
    DEFAULT_HYDRATE_MODE;
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
  let credentialLease: SlackGatewayCredentialLease | undefined;
  let leaseHeartbeat: SlackGatewayCredentialHeartbeat | undefined;
  let leaseId = explicitLeaseId;
  let summary: MantisSlackDesktopSmokeSummary | undefined;
  let screenshotPath: string | undefined;
  let slackQaDir: string | undefined;
  let videoPath: string | undefined;
  let remoteMetadata: SlackDesktopRemoteMetadata | undefined;

  try {
    leaseId =
      leaseId ??
      (await timer.timePhase("crabbox.warmup", () =>
        warmupCrabbox({
          crabboxBin,
          cwd: repoRoot,
          env,
          idleTimeout,
          machineClass,
          provider,
          runner,
          ttl,
        }),
      ));
    if (!leaseId) {
      throw new Error("Crabbox lease id was not resolved.");
    }
    const resolvedLeaseId = leaseId;
    const inspected = await timer.timePhase("crabbox.inspect", () =>
      inspectCrabbox({
        crabboxBin,
        cwd: repoRoot,
        env,
        leaseId: resolvedLeaseId,
        provider,
        runner,
      }),
    );
    const preparedCredentialEnv = await timer.timePhase("credentials.prepare", () =>
      prepareGatewayCredentialEnv({
        credentialRole,
        credentialSource,
        env,
        gatewaySetup,
      }),
    );
    credentialLease = preparedCredentialEnv.credentialLease;
    leaseHeartbeat = preparedCredentialEnv.leaseHeartbeat;
    let remoteRunError: unknown;
    const remoteRunStartedAt = new Date();
    await runCommand({
      command: crabboxBin,
      args: [
        "run",
        "--provider",
        provider,
        "--id",
        resolvedLeaseId,
        "--desktop",
        "--browser",
        "--shell",
        "--",
        renderRemoteScript({
          alternateModel,
          credentialRole,
          credentialSource,
          fastMode,
          hydrateMode,
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
    }).then(
      () => {
        timer.recordPhase("crabbox.remote_run", remoteRunStartedAt, "pass");
      },
      (error: unknown) => {
        timer.recordPhase("crabbox.remote_run", remoteRunStartedAt, "fail");
        remoteRunError = error;
        return { stdout: "", stderr: "" };
      },
    );
    leaseHeartbeat?.throwIfFailed();
    await timer.timePhase("artifacts.copy", () =>
      copyRemoteArtifacts({
        cwd: repoRoot,
        env,
        inspect: inspected,
        outputDir,
        remoteOutputDir,
        runner,
      }),
    );
    screenshotPath = path.join(outputDir, "slack-desktop-smoke.png");
    videoPath = path.join(outputDir, "slack-desktop-smoke.mp4");
    if (!(await pathExists(videoPath))) {
      videoPath = undefined;
    }
    remoteMetadata = await readRemoteMetadata(outputDir);
    slackQaDir = path.join(outputDir, "slack-qa");
    if (!(await pathExists(screenshotPath))) {
      throw new Error("Slack desktop screenshot was not copied back from Crabbox.");
    }
    const gatewaySetupCompleted =
      gatewaySetup && remoteMetadata?.qaExitCode === 0 && remoteMetadata.gatewayAlive === true;
    if (remoteRunError && gatewaySetupCompleted) {
      timer.updatePhaseStatus("crabbox.remote_run", "accepted");
    }
    if (remoteRunError && !gatewaySetupCompleted) {
      throw remoteRunError;
    }
    if (gatewaySetup && !gatewaySetupCompleted) {
      throw new Error("Slack desktop gateway setup did not report a live OpenClaw gateway.");
    }
    summary = {
      artifacts: {
        reportPath,
        screenshotPath,
        slackQaDir,
        summaryPath,
        videoPath,
      },
      crabbox: {
        bin: crabboxBin,
        createdLease,
        id: resolvedLeaseId,
        provider,
        slug: inspected.slug,
        state: inspected.state,
        vncCommand: `${crabboxBin} vnc --provider ${provider} --id ${resolvedLeaseId} --open`,
      },
      finishedAt: new Date().toISOString(),
      hydrateMode: normalizeHydrateMode(remoteMetadata?.hydrateMode) ?? hydrateMode,
      outputDir,
      remoteOutputDir,
      slackUrl: trimToValue(remoteMetadata?.openedUrl) ?? slackUrl,
      startedAt: startedAt.toISOString(),
      status: "pass",
      timings: timer.snapshot(),
    };
    return {
      outputDir,
      reportPath,
      screenshotPath,
      status: "pass",
      summaryPath,
      videoPath,
    };
  } catch (error) {
    summary = {
      artifacts: {
        reportPath,
        screenshotPath,
        slackQaDir,
        summaryPath,
        videoPath,
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
      hydrateMode,
      outputDir,
      remoteOutputDir,
      slackUrl,
      startedAt: startedAt.toISOString(),
      status: "fail",
      timings: timer.snapshot(),
    };
    await fs.writeFile(path.join(outputDir, "error.txt"), `${summary.error}\n`, "utf8");
    return {
      outputDir,
      reportPath,
      screenshotPath,
      status: "fail",
      summaryPath,
      videoPath,
    };
  } finally {
    if (summary) {
      summary.finishedAt = new Date().toISOString();
      summary.timings = timer.snapshot();
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await fs.writeFile(reportPath, renderReport(summary), "utf8");
    }
    if (createdLease && leaseId && !keepLease) {
      await stopCrabbox({ crabboxBin, cwd: repoRoot, env, leaseId, provider, runner });
    }
    if (leaseHeartbeat) {
      await leaseHeartbeat.stop().catch((error: unknown) => {
        console.warn(`Slack credential heartbeat cleanup failed: ${formatErrorMessage(error)}`);
      });
    }
    if (credentialLease) {
      await credentialLease.release().catch((error: unknown) => {
        console.warn(`Slack credential release failed: ${formatErrorMessage(error)}`);
      });
    }
  }
}
