/** Detached macOS launchd restart handoff for restarting from inside the service. */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatErrorMessage } from "../infra/errors.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "./launchd-plist.js";
import { renderPosixRestartLogSetup } from "./restart-logs.js";

type LaunchdRestartHandoffMode = "kickstart" | "reload" | "start-after-exit";

type LaunchdRestartHandoffResult = Result<number | undefined, string>;

type LaunchdRestartTarget = {
  domain: string;
  plistPath: string;
  serviceTarget: string;
};

const START_AFTER_EXIT_PRINT_RETRY_COUNT = 15;
const START_AFTER_EXIT_PRINT_RETRY_DELAY_SECONDS = 0.2;
// The booted-out label stays registered until launchd finishes stopping the
// old process. ExitTimeOut bounds that stop with SIGKILL, so the reload wait is
// that ceiling plus teardown margin. A 3s poll could advance mid-stop and
// strand the LaunchAgent (#110137).
const RELOAD_BOOTOUT_WAIT_DELAY_SECONDS = 1;
const RELOAD_BOOTOUT_WAIT_COUNT = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 15;
const RELOAD_BOOTSTRAP_RETRY_COUNT = 15;

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

function resolveLaunchdRestartTarget(
  env: Record<string, string | undefined> = process.env,
): LaunchdRestartTarget {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const home = normalizeOptionalString(env.HOME) || os.homedir();
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  return {
    domain,
    plistPath,
    serviceTarget: `${domain}/${label}`,
  };
}

function buildLaunchdRestartScript(
  mode: LaunchdRestartHandoffMode,
  restartLogEnv: LaunchdRestartLogEnv,
): string {
  // The detached shell waits for the caller before touching launchd so the
  // current gateway process can exit cleanly after scheduling the handoff.
  const waitForCallerPid = `wait_pid="$4"
${renderPosixRestartLogSetup(restartLogEnv)}
printf '[%s] openclaw restart attempt source=handoff mode=${mode} target=%s pid=%s interactive=0\\n' "$(date -u +%FT%TZ)" "$service_target" "$wait_pid" >&2
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
    status=0
  else
    launchctl kickstart -k "$service_target"
    status=$?
  fi
fi
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=handoff mode=${mode} interactive=0\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=handoff mode=${mode} status=%s interactive=0\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
exit "$status"
`;
  }

  if (mode === "reload") {
    // Reloading is required after plist content changes; kickstart alone keeps
    // launchd's already-loaded stdout/stderr/stdin paths.
    // After bootout the label stays registered until launchd finishes its
    // ExitTimeOut-bounded stop, so this poll must outlast that stop window.
    // Bootstrapping early fails with EIO (Bootstrap failed: 5) and can leave
    // the LaunchAgent deregistered (#110137).
    const bootoutWaitLoop = `bootout_wait_count="${RELOAD_BOOTOUT_WAIT_COUNT}"
while [ "$bootout_wait_count" -gt 0 ]; do
  if ! launchctl print "$service_target" >/dev/null 2>&1; then
    break
  fi
  bootout_wait_count=$((bootout_wait_count - 1))
  sleep ${RELOAD_BOOTOUT_WAIT_DELAY_SECONDS}
done
`;
    // kickstart -k cannot succeed on a booted-out label, so it is only a valid
    // fallback while the label is registered; otherwise retry bootstrap so the
    // handoff never exits with the service deregistered (#110137).
    const bootstrapRetryLoop = `bootstrap_retry_count="${RELOAD_BOOTSTRAP_RETRY_COUNT}"
while :; do
  if launchctl bootstrap "$domain" "$plist_path"; then
    status=0
    break
  else
    # Capture inside the else: after a completed if with a false condition,
    # $? is 0, which would let exhausted retries report a successful restart.
    status=$?
  fi
  if launchctl print "$service_target" >/dev/null 2>&1; then
    if launchctl kickstart -k "$service_target"; then
      status=0
      break
    else
      # The pending bootout can finish between print and kickstart. Keep
      # retrying bootstrap if that check-then-act race deregisters the label.
      status=$?
    fi
  fi
  bootstrap_retry_count=$((bootstrap_retry_count - 1))
  if [ "$bootstrap_retry_count" -le 0 ]; then
    break
  fi
  sleep ${RELOAD_BOOTOUT_WAIT_DELAY_SECONDS}
done
`;
    return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
status=0
launchctl enable "$service_target"
launchctl bootout "$service_target" >/dev/null 2>&1 || true
${bootoutWaitLoop}
${bootstrapRetryLoop}
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=handoff mode=${mode} interactive=0\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=handoff mode=${mode} status=%s interactive=0\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
exit "$status"
`;
  }

  const verifyLaunchdReload = `print_retry_count="${START_AFTER_EXIT_PRINT_RETRY_COUNT}"
while [ "$print_retry_count" -gt 0 ]; do
  if launchctl print "$service_target" >/dev/null 2>&1; then
    printf '[%s] openclaw restart done source=handoff mode=${mode} reason=launchd-auto-reload interactive=0\\n' "$(date -u +%FT%TZ)" >&2
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
  status=0
else
  status=$?
  launchctl kickstart -k "$service_target"
  status=$?
fi
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=handoff mode=${mode} interactive=0\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=handoff mode=${mode} status=%s interactive=0\\n' "$(date -u +%FT%TZ)" "$status" >&2
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
      ],
      {
        detached: true,
        stdio: "ignore",
        env: restartEnv,
      },
    );
    child.unref();
    return ok(child.pid ?? undefined);
  } catch (error) {
    return err(formatErrorMessage(error));
  }
}
