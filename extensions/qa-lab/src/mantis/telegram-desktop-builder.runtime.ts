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

export type MantisTelegramDesktopBuilderOptions = {
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  credentialRole?: string;
  credentialSource?: string;
  env?: NodeJS.ProcessEnv;
  gatewaySetup?: boolean;
  hydrateMode?: MantisTelegramDesktopHydrateMode;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  now?: () => Date;
  outputDir?: string;
  provider?: string;
  repoRoot?: string;
  telegramProfileArchiveEnv?: string;
  telegramProfileDir?: string;
  ttl?: string;
};

export type MantisTelegramDesktopHydrateMode = "prehydrated" | "source";

export type MantisTelegramDesktopBuilderResult = {
  outputDir: string;
  reportPath: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
  videoPath?: string;
};

type TelegramGatewayCredentialPayload = {
  driverToken: string;
  groupId: string;
  sutToken: string;
};

type TelegramGatewayCredentialLease = Awaited<
  ReturnType<typeof acquireQaCredentialLease<TelegramGatewayCredentialPayload>>
>;
type TelegramGatewayCredentialHeartbeat = ReturnType<typeof startQaCredentialLeaseHeartbeat>;

type MantisTelegramDesktopBuilderSummary = {
  artifacts: {
    reportPath: string;
    screenshotPath?: string;
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
  gatewaySetup: boolean;
  hydrateMode: MantisTelegramDesktopHydrateMode;
  outputDir: string;
  remoteOutputDir: string;
  startedAt: string;
  status: "pass" | "fail";
  telegramDesktop: {
    profileArchiveEnv?: string;
    profileDir: string;
  };
  timings: MantisPhaseTimings;
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

type TelegramDesktopRemoteMetadata = {
  gatewayAlive?: boolean;
  gatewayPid?: string;
  hydrateMode?: string;
  qaExitCode?: number;
  telegramDesktopPid?: string;
  telegramProfileRestored?: boolean;
};

const DEFAULT_PROVIDER = "hetzner";
const DEFAULT_CLASS = "beast";
const DEFAULT_IDLE_TIMEOUT = "90m";
const DEFAULT_TTL = "180m";
const DEFAULT_CREDENTIAL_SOURCE = "convex";
const DEFAULT_CREDENTIAL_ROLE = "maintainer";
const DEFAULT_HYDRATE_MODE: MantisTelegramDesktopHydrateMode = "source";
const DEFAULT_TELEGRAM_PROFILE_DIR = "$HOME/.local/share/TelegramDesktop";
const CRABBOX_BIN_ENV = "OPENCLAW_MANTIS_CRABBOX_BIN";
const CRABBOX_PROVIDER_ENV = "OPENCLAW_MANTIS_CRABBOX_PROVIDER";
const CRABBOX_CLASS_ENV = "OPENCLAW_MANTIS_CRABBOX_CLASS";
const CRABBOX_LEASE_ID_ENV = "OPENCLAW_MANTIS_CRABBOX_LEASE_ID";
const CRABBOX_KEEP_ENV = "OPENCLAW_MANTIS_KEEP_VM";
const CRABBOX_IDLE_TIMEOUT_ENV = "OPENCLAW_MANTIS_CRABBOX_IDLE_TIMEOUT";
const CRABBOX_TTL_ENV = "OPENCLAW_MANTIS_CRABBOX_TTL";
const HYDRATE_MODE_ENV = "OPENCLAW_MANTIS_HYDRATE_MODE";
const TELEGRAM_PROFILE_ARCHIVE_ENV = "OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_TGZ_B64";
const TELEGRAM_PROFILE_ARCHIVE_ENV_NAME_ENV =
  "OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_ARCHIVE_ENV";
const TELEGRAM_PROFILE_DIR_ENV = "OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_DIR";

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
): MantisTelegramDesktopHydrateMode | undefined {
  const normalized = trimToValue(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "source" || normalized === "prehydrated") {
    return normalized;
  }
  throw new Error(`Unsupported Mantis Telegram desktop hydrate mode: ${value}`);
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
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `telegram-desktop-${stamp}`);
}

function buildCrabboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  if (!trimToValue(next.OPENCLAW_LIVE_OPENAI_KEY) && trimToValue(next.OPENAI_API_KEY)) {
    next.OPENCLAW_LIVE_OPENAI_KEY = next.OPENAI_API_KEY;
  }
  if (!trimToValue(next.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID)) {
    next.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID = trimToValue(next.OPENCLAW_QA_TELEGRAM_GROUP_ID);
  }
  if (!trimToValue(next.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN)) {
    next.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN = trimToValue(
      next.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN,
    );
  }
  if (!trimToValue(next.OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN)) {
    next.OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN = trimToValue(
      next.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN,
    );
  }
  return next;
}

function resolveTelegramGatewayEnvPayload(
  env: NodeJS.ProcessEnv,
): TelegramGatewayCredentialPayload {
  const groupId = trimToValue(env.OPENCLAW_QA_TELEGRAM_GROUP_ID);
  const driverToken = trimToValue(env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN);
  const sutToken = trimToValue(env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN);
  if (!groupId || !driverToken || !sutToken) {
    throw new Error(
      "Telegram desktop builder requires OPENCLAW_QA_TELEGRAM_GROUP_ID, OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN, and OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN when using --credential-source env.",
    );
  }
  return { driverToken, groupId, sutToken };
}

function parseTelegramGatewayCredentialPayload(payload: unknown): TelegramGatewayCredentialPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Telegram credential payload must be an object.");
  }
  const candidate = payload as Record<string, unknown>;
  const groupId =
    typeof candidate.groupId === "string" ? trimToValue(candidate.groupId) : undefined;
  const driverToken =
    typeof candidate.driverToken === "string" ? trimToValue(candidate.driverToken) : undefined;
  const sutToken =
    typeof candidate.sutToken === "string" ? trimToValue(candidate.sutToken) : undefined;
  if (!groupId || !/^-?\d+$/u.test(groupId) || !driverToken || !sutToken) {
    throw new Error(
      "Telegram credential payload must include numeric groupId, driverToken, and sutToken.",
    );
  }
  return { driverToken, groupId, sutToken };
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
    trimToValue(params.env.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID) &&
    trimToValue(params.env.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN) &&
    trimToValue(params.env.OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN)
  ) {
    return {};
  }
  const credentialLease = await acquireQaCredentialLease<TelegramGatewayCredentialPayload>({
    env: params.env,
    kind: "telegram",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveTelegramGatewayEnvPayload(params.env),
    parsePayload: parseTelegramGatewayCredentialPayload,
  });
  const leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const payload = credentialLease.payload;
  params.env.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID = payload.groupId;
  params.env.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN = payload.driverToken;
  params.env.OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN = payload.sutToken;
  params.env.OPENCLAW_QA_TELEGRAM_GROUP_ID =
    trimToValue(params.env.OPENCLAW_QA_TELEGRAM_GROUP_ID) ?? payload.groupId;
  params.env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN =
    trimToValue(params.env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN) ?? payload.driverToken;
  params.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN =
    trimToValue(params.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN) ?? payload.sutToken;
  return {
    credentialLease,
    leaseHeartbeat,
  };
}

function resolveProfileArchive(params: { env: NodeJS.ProcessEnv; explicitEnvName?: string }): {
  archiveValue?: string;
  envName?: string;
} {
  const envName =
    trimToValue(params.explicitEnvName) ??
    trimToValue(params.env[TELEGRAM_PROFILE_ARCHIVE_ENV_NAME_ENV]) ??
    TELEGRAM_PROFILE_ARCHIVE_ENV;
  return {
    archiveValue: trimToValue(params.env[envName]),
    envName,
  };
}

async function readRemoteMetadata(
  outputDir: string,
): Promise<TelegramDesktopRemoteMetadata | undefined> {
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
      qaExitCode: typeof candidate.qaExitCode === "number" ? candidate.qaExitCode : undefined,
      telegramDesktopPid:
        typeof candidate.telegramDesktopPid === "string" ? candidate.telegramDesktopPid : undefined,
      telegramProfileRestored:
        typeof candidate.telegramProfileRestored === "boolean"
          ? candidate.telegramProfileRestored
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function renderRemoteScript(params: {
  credentialRole: string;
  credentialSource: string;
  hydrateMode: MantisTelegramDesktopHydrateMode;
  remoteOutputDir: string;
  setupGateway: boolean;
  telegramProfileDir: string;
}) {
  const shellOutputDir = shellQuote(params.remoteOutputDir);
  const credentialSource = shellQuote(params.credentialSource);
  const credentialRole = shellQuote(params.credentialRole);
  const hydrateMode = shellQuote(params.hydrateMode);
  const setupGateway = params.setupGateway ? "1" : "0";
  const telegramProfileDir = shellQuote(params.telegramProfileDir);
  return `set -euo pipefail
out=${shellOutputDir}
credential_source=${credentialSource}
credential_role=${credentialRole}
hydrate_mode=${hydrateMode}
setup_gateway=${setupGateway}
telegram_profile_dir=${telegramProfileDir}
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
if ! command -v scrot >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
  sudo apt-get update -y >"$out/apt.log" 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl xz-utils scrot libxcb-cursor0 libxkbcommon-x11-0 libxcb-xinerama0 >>"$out/apt.log" 2>&1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  sudo apt-get update -y >>"$out/apt.log" 2>&1 || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg >>"$out/apt.log" 2>&1 || true
fi
telegram_root="$HOME/.local/share/openclaw-mantis/telegram-desktop-bin"
telegram_bin="$telegram_root/Telegram/Telegram"
if [ ! -x "$telegram_bin" ]; then
  mkdir -p "$telegram_root"
  curl -fsSL https://telegram.org/dl/desktop/linux -o "$out/telegram-desktop.tar.xz"
  tar -xJf "$out/telegram-desktop.tar.xz" -C "$telegram_root"
fi
if [ -z "$telegram_profile_dir" ] || [ "$telegram_profile_dir" = "\\$HOME/.local/share/TelegramDesktop" ]; then
  telegram_profile_dir="$HOME/.local/share/TelegramDesktop"
fi
mkdir -p "$telegram_profile_dir"
telegram_profile_restored=false
if [ -n "\${OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_TGZ_B64:-}" ]; then
  printf '%s' "$OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_TGZ_B64" | base64 -d >"$out/telegram-profile.tgz"
  tar -xzf "$out/telegram-profile.tgz" -C "$telegram_profile_dir"
  telegram_profile_restored=true
fi
video_pid=""
if command -v ffmpeg >/dev/null 2>&1; then
  display_input="$DISPLAY"
  case "$display_input" in
    *.*) ;;
    *) display_input="$display_input.0" ;;
  esac
  ffmpeg -hide_banner -loglevel error -y -f x11grab -framerate 15 -i "$display_input" -t 45 -pix_fmt yuv420p "$out/telegram-desktop-builder.mp4" >"$out/ffmpeg.log" 2>&1 &
  video_pid=$!
else
  echo "ffmpeg missing; video artifact skipped" >"$out/ffmpeg.log"
fi
nohup "$telegram_bin" -workdir "$telegram_profile_dir" </dev/null >"$out/telegram-desktop.log" 2>&1 &
telegram_pid="$!"
sleep 6
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
    export TELEGRAM_BOT_TOKEN="\${OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN:-\${TELEGRAM_BOT_TOKEN:-}}"
    telegram_group_id="\${OPENCLAW_MANTIS_TELEGRAM_GROUP_ID:-}"
    driver_token="\${OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN:-}"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$telegram_group_id" ] || [ -z "$driver_token" ]; then
      echo "Gateway setup requires OPENCLAW_MANTIS_TELEGRAM_GROUP_ID, OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN, and OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN." >&2
      exit 2
    fi
    driver_user_id="$(node --input-type=module >"$out/telegram-driver-getme.json" 2>"$out/telegram-driver-getme.err" <<'MANTIS_TELEGRAM_GETME'
const token = process.env.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN;
const response = await fetch(\`https://api.telegram.org/bot\${token}/getMe\`);
const body = await response.json();
process.stdout.write(JSON.stringify({ ok: body.ok, id: body.result?.id, username: body.result?.username }));
if (!body.ok || !body.result?.id) process.exit(1);
MANTIS_TELEGRAM_GETME
node --input-type=module -e 'import fs from "node:fs"; const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(value.id || ""));' "$out/telegram-driver-getme.json")"
    export OPENCLAW_HOME="$HOME/.openclaw-mantis/telegram-openclaw"
    mkdir -p "$OPENCLAW_HOME"
    cat >"$out/telegram.patch.json5" <<MANTIS_TELEGRAM_PATCH
{
  gateway: {
    port: 38974,
    auth: { mode: "none" },
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
      dmPolicy: "disabled",
      groupPolicy: "allowlist",
      groups: {
        "$telegram_group_id": {
          enabled: true,
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
MANTIS_TELEGRAM_PATCH
    pnpm openclaw config patch --file "$out/telegram.patch.json5" --dry-run
    pnpm openclaw config patch --file "$out/telegram.patch.json5"
    node --input-type=module >"$out/telegram-ready-message.json" 2>"$out/telegram-ready-message.err" <<'MANTIS_TELEGRAM_READY'
const token = process.env.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN;
const chatId = process.env.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID;
const text = \`Mantis Telegram desktop builder ready: \${new Date().toISOString()}\`;
const response = await fetch(\`https://api.telegram.org/bot\${token}/sendMessage\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
});
const body = await response.json();
process.stdout.write(JSON.stringify({ ok: body.ok, message_id: body.result?.message_id }));
if (!body.ok) process.exit(1);
MANTIS_TELEGRAM_READY
    nohup pnpm openclaw gateway run --dev --allow-unconfigured --port 38974 --cli-backend-logs </dev/null >"$out/openclaw-gateway.log" 2>&1 &
    gateway_pid="$!"
    echo "$gateway_pid" >"$out/openclaw-gateway.pid"
    sleep 12
    if ! kill -0 "$gateway_pid" >/dev/null 2>&1; then
      echo "OpenClaw gateway exited during startup." >&2
      wait "$gateway_pid" || true
      exit 1
    fi
    disown "$gateway_pid" >/dev/null 2>&1 || true
  fi
} >"$out/telegram-desktop-builder-command.log" 2>&1 || qa_status=$?
sleep 5
scrot "$out/telegram-desktop-builder.png" || true
if [ -n "$video_pid" ]; then
  wait "$video_pid" || true
fi
cat >"$out/remote-metadata.json" <<MANTIS_REMOTE_METADATA
{
  "display": "$DISPLAY",
  "telegramDesktopBinary": "$telegram_bin",
  "telegramDesktopPid": "$telegram_pid",
  "telegramProfileDir": "$telegram_profile_dir",
  "telegramProfileRestored": $telegram_profile_restored,
  "gatewaySetup": $setup_gateway,
  "gatewayAlive": $(if [ "$setup_gateway" = "1" ] && [ -f "$out/openclaw-gateway.pid" ] && kill -0 "$(cat "$out/openclaw-gateway.pid")" >/dev/null 2>&1; then echo true; else echo false; fi),
  "gatewayPid": "$(if [ -f "$out/openclaw-gateway.pid" ]; then cat "$out/openclaw-gateway.pid"; fi)",
  "gatewayPort": 38974,
  "qaExitCode": $qa_status,
  "credentialSource": "$credential_source",
  "credentialRole": "$credential_role",
  "hydrateMode": "$hydrate_mode",
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANTIS_REMOTE_METADATA
test -s "$out/telegram-desktop-builder.png"
exit "$qa_status"
`;
}

function renderReport(summary: MantisTelegramDesktopBuilderSummary) {
  const lines = [
    "# Mantis Telegram Desktop Builder",
    "",
    `Status: ${summary.status}`,
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
    `- Gateway setup: ${summary.gatewaySetup ? "yes" : "no"}`,
    "",
    "## Telegram Desktop",
    "",
    `- Profile dir: \`${summary.telegramDesktop.profileDir}\``,
    summary.telegramDesktop.profileArchiveEnv
      ? `- Profile archive env: \`${summary.telegramDesktop.profileArchiveEnv}\``
      : undefined,
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
    "- Remote metadata: `remote-metadata.json`",
    "- Remote command log: `telegram-desktop-builder-command.log`",
    "- Telegram Desktop log: `telegram-desktop.log`",
    "- OpenClaw gateway log: `openclaw-gateway.log`",
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
}

export async function runMantisTelegramDesktopBuilder(
  opts: MantisTelegramDesktopBuilderOptions = {},
): Promise<MantisTelegramDesktopBuilderResult> {
  const env = buildCrabboxEnv(opts.env ?? process.env);
  const startedAt = (opts.now ?? (() => new Date()))();
  const timer = createPhaseTimer(startedAt);
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ?? defaultOutputDir(repoRoot, startedAt),
    "Mantis Telegram desktop builder output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-telegram-desktop-builder-summary.json");
  const reportPath = path.join(outputDir, "mantis-telegram-desktop-builder-report.md");
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
  const hydrateMode =
    normalizeHydrateMode(opts.hydrateMode) ??
    normalizeHydrateMode(env[HYDRATE_MODE_ENV]) ??
    DEFAULT_HYDRATE_MODE;
  const gatewaySetup = opts.gatewaySetup ?? true;
  const profileArchive = resolveProfileArchive({
    env,
    explicitEnvName: opts.telegramProfileArchiveEnv,
  });
  if (profileArchive.archiveValue) {
    env[TELEGRAM_PROFILE_ARCHIVE_ENV] = profileArchive.archiveValue;
  }
  const telegramProfileDir =
    trimToValue(opts.telegramProfileDir) ??
    trimToValue(env[TELEGRAM_PROFILE_DIR_ENV]) ??
    DEFAULT_TELEGRAM_PROFILE_DIR;
  env[TELEGRAM_PROFILE_DIR_ENV] = telegramProfileDir;
  const runner = opts.commandRunner ?? defaultCommandRunner;
  const explicitLeaseId = trimToValue(opts.leaseId) ?? trimToValue(env[CRABBOX_LEASE_ID_ENV]);
  const keepLease = opts.keepLease ?? (gatewaySetup || isTruthyOptIn(env[CRABBOX_KEEP_ENV]));
  const createdLease = explicitLeaseId === undefined;
  const remoteOutputDir = `/tmp/openclaw-mantis-telegram-desktop-${startedAt
    .toISOString()
    .replace(/[^0-9A-Za-z]/gu, "-")}`;
  let credentialLease: TelegramGatewayCredentialLease | undefined;
  let leaseHeartbeat: TelegramGatewayCredentialHeartbeat | undefined;
  let leaseId = explicitLeaseId;
  let summary: MantisTelegramDesktopBuilderSummary | undefined;
  let screenshotPath: string | undefined;
  let videoPath: string | undefined;

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
        "--shell",
        "--",
        renderRemoteScript({
          credentialRole,
          credentialSource,
          hydrateMode,
          remoteOutputDir,
          setupGateway: gatewaySetup,
          telegramProfileDir,
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
    screenshotPath = path.join(outputDir, "telegram-desktop-builder.png");
    videoPath = path.join(outputDir, "telegram-desktop-builder.mp4");
    if (!(await pathExists(videoPath))) {
      videoPath = undefined;
    }
    const remoteMetadata = await readRemoteMetadata(outputDir);
    if (!(await pathExists(screenshotPath))) {
      throw new Error("Telegram desktop screenshot was not copied back from Crabbox.");
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
      throw new Error("Telegram desktop builder did not report a live OpenClaw gateway.");
    }
    summary = {
      artifacts: {
        reportPath,
        screenshotPath,
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
      gatewaySetup,
      hydrateMode: normalizeHydrateMode(remoteMetadata?.hydrateMode) ?? hydrateMode,
      outputDir,
      remoteOutputDir,
      startedAt: startedAt.toISOString(),
      status: "pass",
      telegramDesktop: {
        profileArchiveEnv: profileArchive.archiveValue ? profileArchive.envName : undefined,
        profileDir: telegramProfileDir,
      },
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
      gatewaySetup,
      hydrateMode,
      outputDir,
      remoteOutputDir,
      startedAt: startedAt.toISOString(),
      status: "fail",
      telegramDesktop: {
        profileArchiveEnv: profileArchive.archiveValue ? profileArchive.envName : undefined,
        profileDir: telegramProfileDir,
      },
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
        console.warn(`Telegram credential heartbeat cleanup failed: ${formatErrorMessage(error)}`);
      });
    }
    if (credentialLease) {
      await credentialLease.release().catch((error: unknown) => {
        console.warn(`Telegram credential release failed: ${formatErrorMessage(error)}`);
      });
    }
  }
}
