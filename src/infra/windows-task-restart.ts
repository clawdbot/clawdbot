// Relaunches the gateway through the managed Windows scheduled task.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { renderCmdRestartLogSetup } from "../daemon/restart-logs.js";
import { resolveTaskScriptPath } from "../daemon/schtasks.js";
import { normalizeGatewayHttpProbeHost } from "../gateway/local-http-probe.js";
import { formatErrorMessage } from "./errors.js";
import type { RestartAttempt } from "./restart.types.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { encodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;
// The predecessor gateway process needs time to finish its own log-flush exit;
// treat a still-running task instance as "predecessor" only while that pid is
// alive so the handoff never mistakes its own predecessor for a successor.
const PREDECESSOR_WAIT_LIMIT = 60;
const PREDECESSOR_WAIT_DELAY_SEC = 1;
// Successor readiness: the relaunched gateway serves its unauthenticated
// /healthz contract during startup; a successor that never answers within
// this budget is a failed handoff and must fall back instead of silently
// ending the restart.
const SUCCESSOR_READINESS_PROBE_LIMIT = 90;
const SUCCESSOR_READINESS_PROBE_DELAY_SEC = 2;
const SUCCESSOR_READINESS_CONNECT_TIMEOUT_MS = 2000;
// Gateway /healthz contract verified by the successor probe before recovery.
const SUCCESSOR_READINESS_TIMEOUT_SEC = Math.round(SUCCESSOR_READINESS_CONNECT_TIMEOUT_MS / 1000);

/**
 * How the detached helper probes the successor gateway's /healthz contract.
 * Mirrors the configured local probe's transport semantics: wildcard bind
 * hosts are normalized to loopback, TLS gateways are probed over HTTPS with
 * the exact certificate pin, and a TLS gateway whose pin cannot be resolved
 * is explicitly left unverified instead of being failed by a plaintext probe.
 */
export type GatewaySuccessorProbe =
  | { transport: "http"; host: string; port: number }
  | { transport: "https"; host: string; port: number; fingerprintSha256: string }
  | { transport: "unverified"; reason: string };

/**
 * Typed internal handoff context carried through the restart call chain
 * (run loop → respawn → restart → helper script). Keeping this out of the
 * environment surface means no new process-visible OPENCLAW_* names.
 */
export type GatewayWindowsTaskHandoff = {
  predecessorPid: number;
  successorProbe?: GatewaySuccessorProbe;
};

type SuccessorReadiness =
  | { mode: "http"; host: string; port: number }
  | { mode: "https"; host: string; port: number; fingerprintSha256: string }
  | { mode: "unverified"; note?: string };

function quotePowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

/**
 * Normalizes the typed handoff into script-safe pieces. Only values that can
 * be embedded in the generated cmd/PowerShell without injection risk survive;
 * anything malformed degrades to an explicit unverified outcome instead of
 * being interpolated into the script.
 */
function resolveSuccessorReadiness(
  handoff: GatewayWindowsTaskHandoff | undefined,
): SuccessorReadiness {
  const probe = handoff?.successorProbe;
  if (!probe || probe.transport === "unverified") {
    const note =
      probe?.transport === "unverified" && /^[a-z0-9-]{1,64}$/.test(probe.reason)
        ? probe.reason
        : undefined;
    return { mode: "unverified", ...(note ? { note } : {}) };
  }
  if (!Number.isInteger(probe.port) || probe.port <= 0 || probe.port > 65535) {
    return { mode: "unverified" };
  }
  // Canonical local-probe wildcard normalization: bind-any addresses (for
  // example gateway.bind: lan) are probed on loopback, never as 0.0.0.0.
  const host = normalizeGatewayHttpProbeHost(probe.host.trim().toLowerCase());
  if (!/^[a-z0-9._:-]+$/.test(host)) {
    return { mode: "unverified" };
  }
  if (probe.transport === "https") {
    if (!/^[a-f0-9]{64}$/.test(probe.fingerprintSha256)) {
      return { mode: "unverified" };
    }
    return {
      mode: "https",
      host,
      port: probe.port,
      fingerprintSha256: probe.fingerprintSha256,
    };
  }
  return { mode: "http", host, port: probe.port };
}

function resolvePredecessorPid(handoff: GatewayWindowsTaskHandoff | undefined): number | null {
  const pid = handoff?.predecessorPid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

function buildPredecessorAliveCommand(predecessorPid: number): string {
  return [
    `if (Get-Process -Id ${predecessorPid} -ErrorAction SilentlyContinue) { exit 0 }`,
    "exit 1",
  ].join("; ");
}

function quotePowerShellUriHost(host: string, port: number): string {
  // IPv6 literals must be bracketed before they are embedded in the URI.
  const uriHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${uriHost}:${port}`;
}

function buildSuccessorReadinessCommand(
  readiness: SuccessorReadiness & { mode: "http" | "https" },
): string {
  // Raw TCP reachability only proves that something listens on the port; the
  // successor contract is the gateway's own unauthenticated /healthz response
  // (200 with {"ok":true,"status":"live"}), so recovery requires that exact
  // shape and an unrelated listener squatting on the port cannot satisfy it.
  // Any failure (connect, TLS, pin mismatch, non-200, wrong body) makes
  // powershell exit non-zero, which the caller reads as "not ready yet".
  if (readiness.mode === "https") {
    return buildTlsSuccessorReadinessCommand(readiness);
  }
  const healthUri = `http://${quotePowerShellUriHost(readiness.host, readiness.port)}/healthz`;
  return [
    `$r = Invoke-WebRequest -UseBasicParsing -Uri ${quotePowerShellSingleQuotedLiteral(healthUri)} -TimeoutSec ${SUCCESSOR_READINESS_TIMEOUT_SEC}`,
    "$j = $r.Content | ConvertFrom-Json",
    "if ($r.StatusCode -eq 200 -and $j.ok -eq $true -and $j.status -eq 'live') { exit 0 }",
    "exit 1",
  ].join("; ");
}

function buildTlsSuccessorReadinessCommand(
  readiness: SuccessorReadiness & { mode: "https" },
): string {
  const { host, port } = readiness;
  // TLS successors reuse the configured local probe's trust model: only the
  // exact pinned SHA-256 certificate fingerprint is accepted. PowerShell 5.1
  // cannot run a ServerCertificateValidationCallback scriptblock (it fires on
  // a .NET thread without a runspace), so the pin check runs on the main
  // thread instead: AuthenticateAsClient with a trust-all callback is
  // synchronous, then the negotiated remote certificate's SHA-256 hash is
  // compared against the pin. A wrong or mismatched certificate exits 1 and
  // keeps polling; only the pinned certificate proceeds to the /healthz
  // contract check over the raw response.
  const quotedHost = quotePowerShellSingleQuotedLiteral(host);
  const headerHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return [
    `$pin = ${quotePowerShellSingleQuotedLiteral(readiness.fingerprintSha256)}`,
    "try {",
    `$client = New-Object System.Net.Sockets.TcpClient(${quotedHost},${port})`,
    `$client.SendTimeout = ${SUCCESSOR_READINESS_CONNECT_TIMEOUT_MS}`,
    `$client.ReceiveTimeout = ${SUCCESSOR_READINESS_CONNECT_TIMEOUT_MS}`,
    "$callback = [System.Net.Security.RemoteCertificateValidationCallback] { param($s,$c,$ch,$e) $true }",
    "$ssl = New-Object System.Net.Security.SslStream($client.GetStream(),$false,$callback)",
    `$ssl.AuthenticateAsClient(${quotedHost})`,
    "$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)",
    "$fp = [System.BitConverter]::ToString($cert.GetCertHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)).Replace('-','').ToLower()",
    "if ($fp -ne $pin) { exit 1 }",
    "$sep = [string][char]13 + [char]10 + [string][char]13 + [char]10",
    `$req = 'GET /healthz HTTP/1.1' + [char]13 + [char]10 + 'Host: ${headerHost}' + [char]13 + [char]10 + 'Connection: close' + [char]13 + [char]10 + 'Accept: application/json' + [char]13 + [char]10 + [char]13 + [char]10`,
    "$bytes = [System.Text.Encoding]::ASCII.GetBytes($req)",
    "$ssl.Write($bytes,0,$bytes.Length)",
    "$ssl.Flush()",
    "$resp = (New-Object System.IO.StreamReader($ssl)).ReadToEnd()",
    "if ($resp -notmatch '^HTTP/1\\.[01] 200 ') { exit 1 }",
    "$body = $resp.Substring($resp.IndexOf($sep) + 4).Trim()",
    "$j = $body | ConvertFrom-Json",
    "if ($j.ok -eq $true -and $j.status -eq 'live') { exit 0 }",
    "exit 1",
    "} catch { exit 1 }",
  ].join("; ");
}

/**
 * One bounded successor-readiness poll loop, shared by the scheduled-task
 * path and the direct-launch fallback so the probe, budget, and outcome
 * lines cannot drift apart. Readiness only passes when the successor's own
 * listener answers the probe; a still-live predecessor holding the port
 * must not satisfy it.
 */
function buildReadinessPollLines(params: {
  quotedLogPath: string;
  quotedReadinessCommand: string;
  entryLabel?: string;
  probeLabel: string;
  budgetExitLabel: string;
  exitLabel: string;
  exitOutcome: string;
  tailLines: string[];
}): string[] {
  const probeLine = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${params.quotedReadinessCommand} >nul 2>&1`;
  return [
    ...(params.entryLabel ? [params.entryLabel] : []),
    "set /a probes=0",
    `:${params.probeLabel}`,
    probeLine,
    "if not errorlevel 1 goto recovered",
    `if %probes% GEQ ${SUCCESSOR_READINESS_PROBE_LIMIT} goto ${params.budgetExitLabel}`,
    `timeout /t ${SUCCESSOR_READINESS_PROBE_DELAY_SEC} /nobreak >nul`,
    "set /a probes+=1",
    `goto ${params.probeLabel}`,
    `:${params.exitLabel}`,
    params.exitOutcome,
    ...params.tailLines,
  ];
}

function buildScheduledTaskRestartScript(params: {
  quotedLogPath: string;
  setupLines: string[];
  taskName: string;
  taskScriptPath?: string;
  predecessorPid?: number;
  readiness: SuccessorReadiness;
}): string {
  const { quotedLogPath, setupLines, taskName, taskScriptPath, predecessorPid, readiness } = params;
  const quotedTaskName = quoteCmdScriptArg(taskName);
  const queryTaskStateCommand = [
    `$task = Get-ScheduledTask -TaskName ${quotePowerShellSingleQuotedLiteral(taskName)} -ErrorAction SilentlyContinue`,
    "if ($null -ne $task -and $task.State -eq 'Running') { exit 0 }",
    "exit 1",
  ].join("; ");
  const quotedQueryTaskStateCommand = quoteCmdScriptArg(queryTaskStateCommand);
  const quotedPredecessorAliveCommand = predecessorPid
    ? quoteCmdScriptArg(buildPredecessorAliveCommand(predecessorPid))
    : null;
  const quotedReadinessCommand =
    readiness.mode !== "unverified"
      ? quoteCmdScriptArg(buildSuccessorReadinessCommand(readiness))
      : null;
  const unverifiedNote =
    readiness.mode === "unverified" && readiness.note ? ` note=${readiness.note}` : "";
  const lines = [
    "@echo off",
    "setlocal",
    ...setupLines,
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart attempt source=windows-task-handoff target=${quotedTaskName}`,
    `schtasks /Query /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if errorlevel 1 goto fallback",
  ];
  if (quotedPredecessorAliveCommand) {
    // Wait for this handoff's own predecessor pid to exit before treating a
    // running task instance as a successor started by someone else (#137266).
    lines.push(
      "set /a predwaits=0",
      ":waitpred",
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedPredecessorAliveCommand} >nul 2>&1`,
      "if errorlevel 1 goto starttask",
      `if %predwaits% GEQ ${PREDECESSOR_WAIT_LIMIT} (`,
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart note source=windows-task-handoff predecessor-still-alive-after-wait`,
      // A predecessor that outlives the wait budget must never be probed as a
      // successor: the task-state and readiness checks below could otherwise
      // observe the still-running predecessor and record a false recovery
      // (#137266). Record the explicit failure and stop the handoff instead.
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=failed-predecessor-still-alive`,
      "goto cleanup",
      ")",
      `timeout /t ${PREDECESSOR_WAIT_DELAY_SEC} /nobreak >nul`,
      "set /a predwaits+=1",
      "goto waitpred",
    );
  }
  lines.push(
    ":starttask",
    "set /a attempts=0",
    ":retry",
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "set /a attempts+=1",
    // After the predecessor exited, a running task instance is a successor
    // started by another restart path; skip straight to readiness probing.
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedQueryTaskStateCommand} >nul 2>&1`,
    "if not errorlevel 1 goto readiness",
    `schtasks /Run /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if not errorlevel 1 goto readiness",
    `if %attempts% GEQ ${TASK_RESTART_RETRY_LIMIT} goto fallback`,
    "goto retry",
  );
  if (quotedReadinessCommand) {
    lines.push(
      ...buildReadinessPollLines({
        quotedLogPath,
        quotedReadinessCommand,
        entryLabel: ":readiness",
        probeLabel: "probe",
        budgetExitLabel: "fallback",
        exitLabel: "recovered",
        exitOutcome: `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=recovered`,
        tailLines: ["goto cleanup"],
      }),
    );
  } else {
    lines.push(
      ":readiness",
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=started-unverified${unverifiedNote}`,
      "goto cleanup",
    );
  }
  lines.push(
    ":fallback",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart fallback source=windows-task-handoff`,
  );
  if (taskScriptPath) {
    const quotedScript = quoteCmdScriptArg(taskScriptPath);
    const quotedCmd = quoteCmdScriptArg(getWindowsCmdExePath());
    lines.push(
      `if exist ${quotedScript} (`,
      `  start "" /min ${quotedCmd} /d /c ${quotedScript}`,
      ")",
    );
  }
  if (quotedReadinessCommand) {
    // The direct-launch fallback gets its own bounded readiness pass so a
    // failed handoff leaves a durable outcome instead of a silent outage.
    lines.push(
      ...buildReadinessPollLines({
        quotedLogPath,
        quotedReadinessCommand,
        probeLabel: "fallbackprobe",
        budgetExitLabel: "handofffailed",
        exitLabel: "handofffailed",
        exitOutcome: `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=failed-successor-not-ready`,
        tailLines: [],
      }),
    );
  }
  lines.push(
    ":cleanup",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart finished source=windows-task-handoff`,
    'del "%~f0" >nul 2>&1',
  );
  return lines.join("\r\n");
}

export function relaunchGatewayScheduledTask(
  env: NodeJS.ProcessEnv = process.env,
  handoff?: GatewayWindowsTaskHandoff,
): RestartAttempt {
  const taskName = resolveWindowsTaskName(env);
  const taskScriptPath = resolveTaskScriptPath(env);
  const predecessorPid = resolvePredecessorPid(handoff) ?? undefined;
  const readiness = resolveSuccessorReadiness(handoff);
  const scriptPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-schtasks-restart-${randomUUID()}.cmd`,
  );
  const quotedScriptPath = quoteCmdScriptArg(scriptPath);
  const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });
  try {
    // The script embeds host paths and the task name; cmd.exe decodes it with
    // the console code page, so plain UTF-8 garbles CJK content (#107416).
    fs.writeFileSync(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: `${buildScheduledTaskRestartScript({
          quotedLogPath: restartLog.quotedLogPath,
          setupLines: restartLog.lines,
          taskName,
          taskScriptPath,
          predecessorPid,
          readiness,
        })}\r\n`,
      }),
    );
    const cmdExePath = getWindowsCmdExePath();
    const child = spawn(cmdExePath, ["/d", "/s", "/c", quotedScriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      method: "schtasks",
      tried: [`schtasks /Run /TN "${taskName}"`, `${cmdExePath} /d /s /c ${quotedScriptPath}`],
    };
  } catch (err) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup; keep the original restart failure.
    }
    return {
      ok: false,
      method: "schtasks",
      detail: formatErrorMessage(err),
      tried: [`schtasks /Run /TN "${taskName}"`],
    };
  }
}
