import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
} from "../infra/windows-install-roots.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { launchFallbackTaskScript } from "./schtasks-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";

const POLL_INTERVAL_MS = 200;
const RUN_EVENT_SETTLE_MS = 2_000;
const WAIT_TIMEOUT_MS = 30_000;

export type ProbeRunEvent = {
  phase: "listening" | "started";
  pid: number;
  ppid: number;
};

export type NativeStartupFallbackProof = {
  directLaunchPid: number;
  directLauncherPid: number;
  batchLaunchPid: number;
  batchLauncherPid: number;
  missingExecutableError: string;
  missingScriptError: string;
  deniedReadError: string;
  aclDiagnostics: NativeStartupAclDiagnostics;
  existenceCheckIgnoredAcl: true;
  completedAfterLauncherExit: true;
};

type NativeAclCommandResult = {
  exitCode: number | null;
  accessDenied: boolean;
  spawnErrorCode: string | null;
};

type NativeStartupAclDiagnostics = {
  backupPrivilege: "enabled" | "disabled" | "absent" | "unknown";
  nodeOpen: { opened: boolean; readData: boolean; errorCode: string | null };
  dotnetOpenRead: NativeAclCommandResult;
  cmdType: NativeAclCommandResult;
  cmdBatch: NativeAclCommandResult & { markerWritten: boolean };
};

async function expectNativeLaunchFailure(
  operation: () => Promise<void>,
  expectedCodes: readonly string[],
): Promise<string> {
  try {
    await operation();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && expectedCodes.includes(code)) {
      return code;
    }
    throw new Error(`Startup fallback rejected with unexpected error ${code ?? "unknown"}`, {
      cause: error,
    });
  }
  throw new Error("Startup fallback reported success for an unlaunchable command");
}

async function waitForNativeLaunchMarker(markerPath: string, launcherPid: number): Promise<number> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const marker = await fs.readFile(markerPath, "utf8").catch(() => "");
    if (marker) {
      const [childIdentity, parentIdentity] = marker.trim().split(":");
      const pid = Number(childIdentity);
      if (!Number.isSafeInteger(pid) || pid <= 1 || Number(parentIdentity) !== launcherPid) {
        throw new Error("Startup fallback probe recorded an invalid process identity");
      }
      return pid;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
  throw new Error("Startup fallback detached process did not write its launch marker");
}

async function runShortLivedStartupLauncher(params: {
  harnessPath: string;
  markerPath: string;
  mode: "batch" | "direct";
  parentPidPath: string;
  probePath: string;
}): Promise<{ launcherPid: number; childPid: number }> {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      params.harnessPath,
      params.mode,
      params.markerPath,
      params.parentPidPath,
      params.probePath,
    ],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: WAIT_TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Startup fallback ${params.mode} launcher parent did not exit successfully`, {
      cause: result.error,
    });
  }
  const launcherPid = Number((await fs.readFile(params.parentPidPath, "utf8")).trim());
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 1) {
    throw new Error("Startup fallback recorded an invalid launcher parent identity");
  }
  return {
    launcherPid,
    childPid: await waitForNativeLaunchMarker(params.markerPath, launcherPid),
  };
}

function resolveCurrentWindowsUserSid(): string {
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  const sid = result.stdout?.trim();
  if (result.error || result.status !== 0 || !sid || !/^S-1-[0-9-]+$/u.test(sid)) {
    throw new Error("Could not resolve the current Windows user SID for isolated ACL proof");
  }
  return sid;
}

function updateNativeScriptAcl(scriptPath: string, args: string[]): void {
  const result = spawnSync(getWindowsSystem32ExePath("icacls.exe"), [scriptPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not update isolated Startup script ACL (exit ${result.status ?? "unknown"})`,
      {
        cause: result.error,
      },
    );
  }
}

function inspectNativeAclCommand(
  executable: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  windowsVerbatimArguments = false,
): NativeAclCommandResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env,
    windowsHide: true,
    windowsVerbatimArguments,
    timeout: 10_000,
  });
  return {
    exitCode: result.status,
    accessDenied: /access is denied|unauthorizedaccessexception|permission denied/i.test(
      result.stderr ?? "",
    ),
    spawnErrorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
  };
}

function resolveWindowsBackupPrivilegeState(): NativeStartupAclDiagnostics["backupPrivilege"] {
  const result = spawnSync(
    getWindowsSystem32ExePath("whoami.exe"),
    ["/priv", "/fo", "csv", "/nh"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0) {
    return "unknown";
  }
  const privilege = result.stdout
    .split(/\r?\n/u)
    .find((line) => line.includes("SeBackupPrivilege"));
  if (!privilege) {
    return "absent";
  }
  const state = privilege.split(",").at(-1)?.replaceAll('"', "").trim().toLowerCase();
  return state === "enabled" || state === "disabled" ? state : "unknown";
}

async function inspectNativeAclDenial(params: {
  batchMarkerPath: string;
  scriptPath: string;
}): Promise<NativeStartupAclDiagnostics> {
  const scriptEnv = { ...process.env, OPENCLAW_TASK_SCRIPT: params.scriptPath };
  const nodeOpen: NativeStartupAclDiagnostics["nodeOpen"] = {
    opened: false,
    readData: false,
    errorCode: null,
  };
  try {
    const handle = await fs.open(params.scriptPath, "r");
    nodeOpen.opened = true;
    try {
      const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, 0);
      nodeOpen.readData = bytesRead === 1;
    } finally {
      await handle.close();
    }
  } catch (error) {
    nodeOpen.errorCode = (error as NodeJS.ErrnoException).code ?? "unknown";
  }

  const dotnetOpenRead = inspectNativeAclCommand(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$ErrorActionPreference="Stop"; $stream=[System.IO.File]::OpenRead($env:OPENCLAW_TASK_SCRIPT); try { [void]$stream.ReadByte() } finally { $stream.Dispose() }',
    ],
    scriptEnv,
  );
  const cmdType = inspectNativeAclCommand(
    getWindowsCmdExePath(),
    ["/d", "/s", "/v:off", "/c", '"type "%OPENCLAW_TASK_SCRIPT%""'],
    scriptEnv,
    true,
  );
  await fs.rm(params.batchMarkerPath, { force: true });
  const cmdBatchResult = inspectNativeAclCommand(
    getWindowsCmdExePath(),
    ["/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""'],
    scriptEnv,
    true,
  );
  const markerWritten = await fs
    .access(params.batchMarkerPath)
    .then(() => true)
    .catch(() => false);

  return {
    backupPrivilege: resolveWindowsBackupPrivilegeState(),
    nodeOpen,
    dotnetOpenRead,
    cmdType,
    cmdBatch: { ...cmdBatchResult, markerWritten },
  };
}

export async function proveNativeStartupFallbackLaunch(params: {
  env: GatewayServiceEnv;
  rootDir: string;
}): Promise<NativeStartupFallbackProof> {
  const proofRoot = path.join(params.rootDir, "startup-fallback-proof");
  const stateDir = path.join(proofRoot, "state & %OPENCLAW_STARTUP_PROBE% !");
  const env: GatewayServiceEnv = {
    ...params.env,
    APPDATA: path.join(proofRoot, "appdata"),
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
  };
  const scriptPath = resolveTaskScriptPath(env);
  const probePath = path.join(proofRoot, "probe.cjs");
  const harnessPath = path.join(proofRoot, "launcher.mts");
  const directMarkerPath = path.join(proofRoot, "direct.pid");
  const directParentPidPath = path.join(proofRoot, "direct-parent.pid");
  const batchMarkerPath = path.join(proofRoot, "batch.pid");
  const batchParentPidPath = path.join(proofRoot, "batch-parent.pid");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    probePath,
    [
      'const fs = require("node:fs");',
      'const launcherPid = Number(fs.readFileSync(process.argv[3], "utf8"));',
      "const deadline = Date.now() + 10_000;",
      "function waitForLauncherExit() {",
      "  try { process.kill(launcherPid, 0); } catch (error) {",
      '    if (error.code !== "ESRCH") throw error;',
      "    fs.writeFileSync(process.argv[2], `${process.pid}:${launcherPid}`);",
      "    return;",
      "  }",
      "  if (Date.now() >= deadline) process.exit(2);",
      "  setTimeout(waitForLauncherExit, 25);",
      "}",
      "waitForLauncherExit();",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    harnessPath,
    [
      'import fs from "node:fs";',
      `import { launchFallbackTaskScript } from ${JSON.stringify(new URL("./schtasks-runtime.ts", import.meta.url).href)};`,
      `const env = ${JSON.stringify({
        APPDATA: env.APPDATA,
        OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_PROFILE: env.OPENCLAW_PROFILE,
        OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
      })};`,
      "const [mode, markerPath, parentPidPath, probePath] = process.argv.slice(2);",
      "fs.writeFileSync(parentPidPath, String(process.pid));",
      "const command = mode === 'direct' ? {",
      "  programArguments: [process.execPath, probePath, markerPath, parentPidPath],",
      `  workingDirectory: ${JSON.stringify(proofRoot)},`,
      "} : null;",
      "await launchFallbackTaskScript(env, command);",
      "",
    ].join("\n"),
  );

  const missingScriptError = await expectNativeLaunchFailure(
    () => launchFallbackTaskScript(env, null),
    ["ENOENT"],
  );
  await fs.writeFile(
    scriptPath,
    `@echo off\r\n"${process.execPath}" "${probePath}" "${batchMarkerPath}" "${batchParentPidPath}"\r\n`,
    "utf8",
  );
  const missingExecutableError = await expectNativeLaunchFailure(
    () =>
      launchFallbackTaskScript(env, {
        programArguments: [path.join(proofRoot, "missing-node.exe"), probePath, directMarkerPath],
        workingDirectory: proofRoot,
      }),
    ["ENOENT"],
  );
  const directLaunch = await runShortLivedStartupLauncher({
    harnessPath,
    markerPath: directMarkerPath,
    mode: "direct",
    parentPidPath: directParentPidPath,
    probePath,
  });
  const batchLaunch = await runShortLivedStartupLauncher({
    harnessPath,
    markerPath: batchMarkerPath,
    mode: "batch",
    parentPidPath: batchParentPidPath,
    probePath,
  });

  const userSid = `*${resolveCurrentWindowsUserSid()}`;
  updateNativeScriptAcl(scriptPath, ["/deny", `${userSid}:(RD)`]);
  let deniedReadError: string;
  let aclDiagnostics: NativeStartupAclDiagnostics;
  try {
    // Node's existence and privileged backup opens bypass the DACL; cmd must still reject it.
    await fs.access(scriptPath);
    aclDiagnostics = await inspectNativeAclDenial({ batchMarkerPath, scriptPath });
    console.info(`[windows-startup-acl] ${JSON.stringify(aclDiagnostics)}`);
    deniedReadError = await expectNativeLaunchFailure(
      () => launchFallbackTaskScript(env, null),
      ["EACCES", "EPERM"],
    );
  } finally {
    updateNativeScriptAcl(scriptPath, ["/remove:d", userSid]);
  }
  await (await fs.open(scriptPath, "r")).close();

  return {
    directLaunchPid: directLaunch.childPid,
    directLauncherPid: directLaunch.launcherPid,
    batchLaunchPid: batchLaunch.childPid,
    batchLauncherPid: batchLaunch.launcherPid,
    missingExecutableError,
    missingScriptError,
    deniedReadError,
    aclDiagnostics,
    existenceCheckIgnoredAcl: true,
    completedAfterLauncherExit: true,
  };
}

async function readRunEvents(eventsPath: string): Promise<ProbeRunEvent[]> {
  const content = await fs.readFile(eventsPath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Partial<ProbeRunEvent>;
      if (
        (parsed.phase !== "started" && parsed.phase !== "listening") ||
        !Number.isSafeInteger(parsed.pid) ||
        (parsed.pid ?? 0) <= 1 ||
        !Number.isSafeInteger(parsed.ppid) ||
        (parsed.ppid ?? 0) <= 1
      ) {
        throw new Error("Scheduled Task probe recorded an invalid run event");
      }
      return parsed as ProbeRunEvent;
    });
}

export async function waitForExactProbeRun(
  eventsPath: string,
  expectedCount: number,
): Promise<ProbeRunEvent> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let events: ProbeRunEvent[] = [];
  while (Date.now() < deadline) {
    events = await readRunEvents(eventsPath);
    if (events.filter((event) => event.phase === "listening").length >= expectedCount) {
      await new Promise((resolve) => {
        setTimeout(resolve, RUN_EVENT_SETTLE_MS);
      });
      events = await readRunEvents(eventsPath);
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }

  const started = events.filter((event) => event.phase === "started");
  const listening = events.filter((event) => event.phase === "listening");
  if (started.length !== expectedCount || listening.length !== expectedCount) {
    throw new Error(
      `Expected exactly ${expectedCount} Scheduled Task probe runs; observed ${started.length} starts and ${listening.length} listeners`,
    );
  }
  const startedEvent = started[expectedCount - 1];
  const listeningEvent = listening[expectedCount - 1];
  if (!startedEvent || !listeningEvent) {
    throw new Error(`Scheduled Task run ${expectedCount} did not record complete process events`);
  }
  if (startedEvent.pid !== listeningEvent.pid || startedEvent.ppid !== listeningEvent.ppid) {
    throw new Error(
      `Scheduled Task run ${expectedCount} changed process identity before listening`,
    );
  }
  return startedEvent;
}
