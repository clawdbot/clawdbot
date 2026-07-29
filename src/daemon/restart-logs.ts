/** Resolves daemon log paths and shell snippets for restart handoff diagnostics. */
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import { resolveGatewayProfileSuffix } from "./constants.js";
import { resolveGatewayStateDir, resolveHomeDir } from "./paths.js";
import type { GatewayLifecycleMutationMode, GatewayServiceEnv } from "./service-types.js";

const GATEWAY_RESTART_LOG_FILENAME = "gateway-restart.log";

export type GatewayLifecycleAuditSource = "cli" | "safe-rpc" | "supervisor" | "handoff";

type GatewayLifecycleAuditEntry = {
  action: "start" | "stop" | "restart";
  source: GatewayLifecycleAuditSource;
  mode: GatewayLifecycleMutationMode;
  pid?: number;
  interactive: boolean;
};

type GatewayLogPaths = {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
};

// Restart logs capture supervisor handoff output when normal service logs are unavailable.
function resolveGatewayLogPrefix(env: GatewayServiceEnv): string {
  return env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
}

function resolveMacLaunchAgentLogPrefix(env: GatewayServiceEnv): string {
  return (
    env.OPENCLAW_LOG_PREFIX?.trim() || `gateway${resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE)}`
  );
}

export function resolveGatewayLogPaths(env: GatewayServiceEnv): GatewayLogPaths {
  const stateDir = resolveGatewayStateDir(env);
  const logDir = path.join(stateDir, "logs");
  const prefix = resolveGatewayLogPrefix(env);
  return {
    logDir,
    stdoutPath: path.join(logDir, `${prefix}.log`),
    stderrPath: path.join(logDir, `${prefix}.err.log`),
  };
}

function resolveMacLaunchAgentLogPaths(env: GatewayServiceEnv): GatewayLogPaths {
  const home = resolveHomeDir(env).replaceAll("\\", "/");
  const logDir = path.posix.join(home, "Library", "Logs", "openclaw");
  const prefix = resolveMacLaunchAgentLogPrefix(env);
  return {
    logDir,
    stdoutPath: path.posix.join(logDir, `${prefix}.log`),
    stderrPath: path.posix.join(logDir, `${prefix}.err.log`),
  };
}

export function resolveGatewaySupervisorLogPaths(
  env: GatewayServiceEnv,
  options?: { platform?: NodeJS.Platform },
): GatewayLogPaths {
  // launchd supervisors write to ~/Library/Logs; systemd and schtasks use the
  // OpenClaw state dir so generated service users can create the directory.
  return (options?.platform ?? process.platform) === "darwin"
    ? resolveMacLaunchAgentLogPaths(env)
    : resolveGatewayLogPaths(env);
}

export function resolveGatewayRestartLogPath(env: GatewayServiceEnv): string {
  return path.join(resolveGatewayLogPaths(env).logDir, GATEWAY_RESTART_LOG_FILENAME);
}

/** Append one best-effort lifecycle record without letting diagnostics block the mutation. */
export function appendGatewayLifecycleAuditLog(
  env: GatewayServiceEnv,
  entry: GatewayLifecycleAuditEntry,
): void {
  try {
    const logPath = resolveGatewayRestartLogPath(env);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fields = [
      `source=${entry.source}`,
      `action=${entry.action}`,
      `mode=${entry.mode}`,
      ...(entry.pid !== undefined ? [`pid=${entry.pid}`] : []),
      `interactive=${entry.interactive ? 1 : 0}`,
    ];
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] openclaw gateway lifecycle ${fields.join(" ")}\n`,
      "utf8",
    );
  } catch {
    // Lifecycle logging is diagnostic only; service control remains authoritative.
  }
}

export function shellEscapeRestartLogValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function renderPosixRestartLogSetup(env: GatewayServiceEnv): string {
  const logDir = path.dirname(resolveGatewayRestartLogPath(env));
  const logPath = resolveGatewayRestartLogPath(env);
  const escapedLogDir = shellEscapeRestartLogValue(logDir);
  const escapedLogPath = shellEscapeRestartLogValue(logPath);
  // Logging is best-effort; restart handoffs must still run when the log path
  // cannot be created in constrained service environments.
  return `if mkdir -p '${escapedLogDir}' 2>/dev/null && : >>'${escapedLogPath}' 2>/dev/null; then
  exec >>'${escapedLogPath}' 2>&1
fi`;
}

export function renderCmdRestartLogSetup(env: GatewayServiceEnv): {
  lines: string[];
  quotedLogPath: string;
} {
  const logPath = resolveGatewayRestartLogPath(env);
  const logDir = path.dirname(logPath);
  const quotedLogDir = quoteCmdScriptArg(logDir);
  const quotedLogPath = quoteCmdScriptArg(logPath);
  return {
    quotedLogPath,
    lines: [
      `if not exist ${quotedLogDir} mkdir ${quotedLogDir} >nul 2>&1`,
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart log initialized`,
    ],
  };
}
