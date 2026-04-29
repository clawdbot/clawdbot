import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";
import { renderPosixRestartLogSetup } from "./restart-logs.js";

export type LaunchdRestartHandoffMode = "kickstart" | "start-after-exit";

export type LaunchdRestartHandoffResult = {
  ok: boolean;
  pid?: number;
  detail?: string;
};

export type LaunchdRestartTarget = {
  domain: string;
  label: string;
  plistPath: string;
  serviceTarget: string;
};

const START_AFTER_EXIT_PRINT_RETRY_COUNT = 15;
const START_AFTER_EXIT_PRINT_RETRY_DELAY_SECONDS = 0.2;

type LaunchdRestartLogEnv = {
  HOME?: string;
  USERPROFILE?: string;
  OPENCLAW_STATE_DIR?: string;
  OPENCLAW_PROFILE?: string;
};

function assertValidLaunchAgentLabel(label: string): string {
  const trimmed = label.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid launchd label: ${sanitizeForLog(trimmed)}`);
  }
  return trimmed;
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

function collectStringEnvOverrides(
  env?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const overrides = Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function collectRestartLogEnv(env?: Record<string, string | undefined>): LaunchdRestartLogEnv {
  const source = { ...process.env, ...env };
  return {
    HOME: source.HOME,
    USERPROFILE: source.USERPROFILE,
    OPENCLAW_STATE_DIR: source.OPENCLAW_STATE_DIR,
    OPENCLAW_PROFILE: source.OPENCLAW_PROFILE,
  };
}

function resolveLaunchAgentLabel(env?: Record<string, string | undefined>): string {
  const envLabel = normalizeOptionalString(env?.OPENCLAW_LAUNCHD_LABEL);
  if (envLabel) {
    return assertValidLaunchAgentLabel(envLabel);
  }
  return assertValidLaunchAgentLabel(resolveGatewayLaunchAgentLabel(env?.OPENCLAW_PROFILE));
}

export function resolveLaunchdRestartTarget(
  env: Record<string, string | undefined> = process.env,
): LaunchdRestartTarget {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const home = normalizeOptionalString(env.HOME) || os.homedir();
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  return {
    domain,
    label,
    plistPath,
    serviceTarget: `${domain}/${label}`,
  };
}

export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const launchdLabel =
    normalizeOptionalString(env.LAUNCH_JOB_LABEL) ||
    normalizeOptionalString(env.LAUNCH_JOB_NAME) ||
    normalizeOptionalString(env.XPC_SERVICE_NAME);
  if (launchdLabel) {
    return launchdLabel === label;
  }
  const configuredLabel = normalizeOptionalString(env.OPENCLAW_LAUNCHD_LABEL);
  return Boolean(configuredLabel && configuredLabel === label);
}

function buildLaunchdRestartScript(
  mode: LaunchdRestartHandoffMode,
  restartLogEnv: LaunchdRestartLogEnv,
): string {
  const waitForCallerPid = `wait_pid="$4"
label="$5"
${renderPosixRestartLogSetup(restartLogEnv)}
printf '[%s] openclaw restart attempt source=launchd-handoff mode=${mode} target=%s waitPid=%s\\n' "$(date -u +%FT%TZ)" "$service_target" "$wait_pid" >&2
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  while kill -0 "$wait_pid" >/dev/null 2>&1; do
    sleep 0.1
  done
fi
`;

  if (mode === "kickstart") {
    // Restart is explicit operator intent; undo any previous `launchctl disable`.
    return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
status=0
launchctl enable "$service_target"
if launchctl kickstart -k "$service_target"; then
  status=0
else
  status=$?
  if launchctl bootstrap "$domain" "$plist_path"; then
    launchctl kickstart -k "$service_target"
    status=$?
  fi
fi
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=launchd-handoff mode=${mode}\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=launchd-handoff mode=${mode} status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
exit "$status"
`;
  }

  const verifyLaunchdReload = `print_retry_count="${START_AFTER_EXIT_PRINT_RETRY_COUNT}"
while [ "$print_retry_count" -gt 0 ]; do
  if launchctl print "$service_target" >/dev/null 2>&1; then
    printf '[%s] openclaw restart done source=launchd-handoff mode=${mode} reason=launchd-auto-reload\\n' "$(date -u +%FT%TZ)" >&2
    exit 0
  fi
  print_retry_count=$((print_retry_count - 1))
  sleep ${START_AFTER_EXIT_PRINT_RETRY_DELAY_SECONDS}
done
`;

  // Restart is explicit operator intent; undo any previous `launchctl disable`.
  return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
${verifyLaunchdReload}
status=0
launchctl enable "$service_target"
if launchctl bootstrap "$domain" "$plist_path"; then
  if launchctl start "$label"; then
    status=0
  else
    launchctl kickstart -k "$service_target"
    status=$?
  fi
else
  status=$?
  launchctl kickstart -k "$service_target"
  status=$?
fi
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=launchd-handoff mode=${mode}\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=launchd-handoff mode=${mode} status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
exit "$status"
`;
}

export function scheduleDetachedLaunchdRestartHandoff(params: {
  env?: Record<string, string | undefined>;
  mode: LaunchdRestartHandoffMode;
  waitForPid?: number;
}): LaunchdRestartHandoffResult {
  const target = resolveLaunchdRestartTarget(params.env);
  const waitForPid =
    typeof params.waitForPid === "number" && Number.isFinite(params.waitForPid)
      ? Math.floor(params.waitForPid)
      : 0;
  const restartLogEnv = collectRestartLogEnv(params.env);
  const restartEnv = sanitizeHostExecEnv({
    baseEnv: process.env,
    overrides: collectStringEnvOverrides(params.env),
  });
  try {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        buildLaunchdRestartScript(params.mode, restartLogEnv),
        "openclaw-launchd-restart-handoff",
        target.serviceTarget,
        target.domain,
        target.plistPath,
        String(waitForPid),
        target.label,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: restartEnv,
      },
    );
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    return {
      ok: false,
      detail: formatErrorMessage(err),
    };
  }
}
