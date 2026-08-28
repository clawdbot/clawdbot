import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "../infra/windows-launcher-encoding.js";
import { parseCmdScriptCommandLine, quoteCmdScriptArg } from "./cmd-argv.js";
import { assertNoCmdLineBreak, parseCmdSetAssignment, renderCmdSetAssignment } from "./cmd-set.js";
import { resolveGatewayWindowsTaskName } from "./constants.js";
import { resolveGatewayTaskScriptPath } from "./paths.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceRenderArgs,
} from "./service-types.js";

export function resolveTaskName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

// Keeps the service gateway's stdin off the (possibly hidden) console so TTY
// heuristics fail closed for permission prompts (#112173).
const STDIN_NUL_REDIRECT = "< NUL";

function stripStdinNulRedirect(commandLine: string): string {
  return commandLine.replace(/\s*<\s*NUL\s*$/i, "");
}

export function shouldFallbackToStartupEntry(params: { code: number; detail: string }): boolean {
  // Permission failures and hung schtasks calls can use the per-user Startup fallback.
  return (
    params.code === 1 ||
    /(?:access is denied|acceso denegado)/i.test(params.detail) ||
    params.code === 124 ||
    /schtasks timed out/i.test(params.detail) ||
    /schtasks produced no output/i.test(params.detail)
  );
}

export function resolveTaskScriptPath(env: GatewayServiceEnv): string {
  return resolveGatewayTaskScriptPath(env);
}

function resolveWindowsStartupDir(env: GatewayServiceEnv): string {
  const appData = env.APPDATA?.trim();
  if (appData) {
    return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) {
    throw new Error("Windows startup folder unavailable: APPDATA/USERPROFILE not set");
  }
  return path.join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

function sanitizeWindowsFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "_");
}

export function resolveStartupEntryPath(env: GatewayServiceEnv, extension?: "cmd" | "vbs"): string {
  const taskName = resolveTaskName(env);
  const entryExtension = extension ?? (shouldUseHiddenWindowsTaskLauncher(env) ? "vbs" : "cmd");
  return path.join(
    resolveWindowsStartupDir(env),
    `${sanitizeWindowsFilename(taskName)}.${entryExtension}`,
  );
}

export function resolveStartupEntryPaths(env: GatewayServiceEnv): string[] {
  const primaryPath = resolveStartupEntryPath(env);
  const legacyCmdPath = resolveStartupEntryPath(env, "cmd");
  const hiddenLauncherPath = resolveStartupEntryPath(env, "vbs");
  // Lifecycle operations must find both launcher variants even without the persisted marker.
  return uniqueStrings([primaryPath, legacyCmdPath, hiddenLauncherPath]);
}

// schtasks `/TR` and cmd.exe parse different surfaces, so keep their quoting separate.
export function quoteSchtasksArg(value: string): string {
  if (!/[ \t"]/g.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

// Escape XML structure; launcher inputs already reject CR/LF in `assertNoCmdLineBreak`.
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// XML is required to disable both battery-stop defaults (#59299); the remaining
// fields mirror the former ONLOGON, least-privilege, single-instance CLI task.
export function buildScheduledTaskXml(params: {
  taskDescription: string;
  taskUser: string | null;
  launchPath: string;
}): string {
  const description = escapeXmlText(params.taskDescription);
  const command = escapeXmlText(params.launchPath);
  const principalLogon = params.taskUser
    ? `\n      <UserId>${escapeXmlText(params.taskUser)}</UserId>\n      <LogonType>InteractiveToken</LogonType>`
    : "\n      <GroupId>S-1-5-32-545</GroupId>";
  const triggerUser = params.taskUser
    ? `\n      <UserId>${escapeXmlText(params.taskUser)}</UserId>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${triggerUser}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalLogon}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
    </Exec>
  </Actions>
</Task>`;
}

export async function writeTaskXmlTempFile(xml: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-xml-"));
  const xmlPath = path.join(tmpDir, "task.xml");
  // Task Scheduler `/XML` expects UTF-16 LE with a BOM on every locale.
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, "utf16le");
  await fs.writeFile(xmlPath, Buffer.concat([bom, body]));
  return xmlPath;
}

export function resolveTaskUser(env: GatewayServiceEnv): string | null {
  const username = env.USERNAME || env.USER || env.LOGNAME;
  if (!username) {
    return null;
  }
  if (username.includes("\\")) {
    return username;
  }
  const domain = env.USERDOMAIN;
  if (normalizeLowercaseStringOrEmpty(domain) === "workgroup") {
    return username;
  }
  if (domain) {
    return `${domain}\\${username}`;
  }
  return username;
}

export function resolveSchtasksCreateUser(
  env: GatewayServiceEnv,
  taskUser: string | null,
): string | null {
  // Workgroup tasks stay XML user-scoped, but omit /RU so schtasks binds the caller.
  if (normalizeLowercaseStringOrEmpty(env.USERDOMAIN) === "workgroup") {
    return null;
  }
  return taskUser;
}

export function shouldUseHiddenWindowsTaskLauncher(env: GatewayServiceEnv): boolean {
  const value = normalizeLowercaseStringOrEmpty(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER);
  return value === "1" || value === "true" || value === "yes";
}

export function resolveTaskLauncherScriptPath(env: GatewayServiceEnv, scriptPath: string): string {
  if (!shouldUseHiddenWindowsTaskLauncher(env)) {
    return scriptPath;
  }
  const parsed = path.parse(scriptPath);
  return path.join(parsed.dir, `${parsed.name}.vbs`);
}

export async function readScheduledTaskCommand(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const lower = normalizeLowercaseStringOrEmpty(line);
      if (line.startsWith("@echo") || lower.startsWith("rem ")) {
        continue;
      }
      if (lower.startsWith("set ")) {
        const assignment = parseCmdSetAssignment(line.slice(4));
        if (assignment) {
          // Generated cmd launchers inline service env before the final command.
          environment[assignment.key] = assignment.value;
        }
        continue;
      }
      if (lower.startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      // Generated launchers redirect stdin so a hidden service console never
      // presents as interactive (#112173); the redirection is not an argument.
      commandLine = stripStdinNulRedirect(line);
      break;
    }
    if (!commandLine) {
      return null;
    }
    const hasEnvironment = Object.keys(environment).length > 0;
    return {
      programArguments: parseCmdScriptCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(hasEnvironment ? { environment } : {}),
      ...(hasEnvironment
        ? {
            environmentValueSources: Object.fromEntries(
              Object.keys(environment).map((key) => [key, "inline"]),
            ),
          }
        : {}),
      sourcePath: scriptPath,
    };
  } catch {
    return null;
  }
}

export function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const lines: string[] = ["@echo off"];
  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Task description");
    lines.push(`rem ${trimmedDescription}`);
  }
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      // `set "NODE_OPTIONS="` clears inherited flags before the Node command runs.
      if (
        value === undefined ||
        (!value && key.toUpperCase() !== "NODE_OPTIONS") ||
        key.toUpperCase() === "PATH"
      ) {
        continue;
      }
      lines.push(renderCmdSetAssignment(key, value));
    }
  }
  // Redirect stdin from NUL: a Scheduled Task console (even hidden via the
  // VBS launcher) still hands the gateway real console handles, so
  // `process.stdin.isTTY` reports true and interactive permission prompts
  // block forever on a console no one can see (#112173). With stdin at NUL
  // the gateway and its workers correctly take non-interactive paths.
  lines.push(`${programArguments.map(quoteCmdScriptArg).join(" ")} ${STDIN_NUL_REDIRECT}`);
  return `${lines.join("\r\n")}\r\n`;
}

function renderStartupLaunchCommand(scriptPath: string): string {
  const cmdExePath = quoteCmdScriptArg(getWindowsCmdExePath());
  return `start "" /min ${cmdExePath} /d /c ${quoteCmdScriptArg(scriptPath)}`;
}

export function buildStartupLauncherScript(params: {
  description?: string;
  scriptPath: string;
}): string {
  const lines = ["@echo off"];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
    lines.push(`rem ${trimmedDescription}`);
  }
  lines.push(renderStartupLaunchCommand(params.scriptPath));
  return `${lines.join("\r\n")}\r\n`;
}

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteVbsRunCommand(scriptPath: string): string {
  return quoteVbsString(`"${scriptPath}"`);
}

export function buildHiddenLauncherScript(params: {
  description?: string;
  scriptPath: string;
}): string {
  const lines = [];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Hidden launcher description");
    lines.push(`' ${trimmedDescription}`);
  }
  lines.push(
    `CreateObject("WScript.Shell").Run ${quoteVbsRunCommand(params.scriptPath)}, 0, False`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

export { encodeWindowsLauncherScript };
