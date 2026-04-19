import path from "node:path";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import { resolveGatewayStateDir } from "./paths.js";
import type { GatewayServiceEnv } from "./service-types.js";

export const GATEWAY_RESTART_LOG_FILENAME = "gateway-restart.log";

export function resolveGatewayLogPaths(env: GatewayServiceEnv): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const stateDir = resolveGatewayStateDir(env);
  const logDir = path.join(stateDir, "logs");
  const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
  return {
    logDir,
    stdoutPath: path.join(logDir, `${prefix}.log`),
    stderrPath: path.join(logDir, `${prefix}.err.log`),
  };
}

export function resolveGatewayRestartLogPath(env: GatewayServiceEnv): string {
  return path.join(resolveGatewayLogPaths(env).logDir, GATEWAY_RESTART_LOG_FILENAME);
}

export function shellEscapeRestartLogValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function renderPosixRestartLogSetup(env: GatewayServiceEnv): string {
  const logDir = path.dirname(resolveGatewayRestartLogPath(env));
  const logPath = resolveGatewayRestartLogPath(env);
  const escapedLogDir = shellEscapeRestartLogValue(logDir);
  const escapedLogPath = shellEscapeRestartLogValue(logPath);
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
