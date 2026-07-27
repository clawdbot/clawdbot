// Guest Transports script supports OpenClaw repository automation.
import { randomUUID } from "node:crypto";
import { sleep } from "../../lib/sleep.mjs";
import { run } from "./host-command.ts";
import type { PhaseRunner } from "./phase-runner.ts";
import { encodePowerShell, psSingleQuote } from "./powershell.ts";
import type { CommandResult } from "./types.ts";

interface GuestExecOptions {
  check?: boolean;
  input?: string;
  timeoutMs?: number;
}

interface WindowsBackgroundPowerShellOptions {
  append?: (chunk: string | Uint8Array) => void;
  beforeLaunchAttempt?: () => void;
  completedLogDrainGraceMs?: number;
  label: string;
  onLaunchRetry?: (message: string) => void;
  pollIntervalMs?: number;
  runCommand?: typeof run;
  script: string;
  timeoutMs: number;
  vmName: string;
}

function guestScriptName(extension: string): string {
  return `openclaw-parallels-${randomUUID()}.${extension}`;
}

function appendOutput(
  append: ((chunk: string | Uint8Array) => void) | undefined,
  result: CommandResult,
): void {
  if (result.stdout) {
    append?.(result.stdout);
  }
  if (result.stderr) {
    append?.(result.stderr);
  }
}

function timeoutBefore(deadline: number, fallbackMs: number): number {
  return Math.min(fallbackMs, Math.max(1_000, deadline - Date.now()));
}

function throwIfFailed(label: string, result: CommandResult, check: boolean | undefined): void {
  if (check === false || result.status === 0) {
    return;
  }
  throw new Error(`${label} failed with exit code ${result.status}`);
}

const PARALLELS_GUEST_SESSION_UNAVAILABLE = "Unable to open new session in this virtual machine.";
const PARALLELS_VM_NOT_STARTED =
  "This operation can be performed for running virtual machines only.";

function throwIfGuestSessionUnavailable(
  label: string,
  result: CommandResult,
  check: boolean | undefined,
): void {
  if (
    check !== false &&
    `${result.stdout}\n${result.stderr}`.includes(PARALLELS_GUEST_SESSION_UNAVAILABLE)
  ) {
    throw new Error(`${label} failed: Parallels guest session unavailable`);
  }
}

function throwIfParallelsVmStopped(label: string, result: CommandResult): void {
  if (result.status !== 0 && result.stderr.includes(PARALLELS_VM_NOT_STARTED)) {
    throw new Error(`${label} failed: Parallels VM stopped`);
  }
}

const POSIX_GUEST_SCRIPT_CLEANUP_TIMEOUT_MS = 30_000;
const WINDOWS_BACKGROUND_LOG_MAX_BYTES = 8 * 1024 * 1024;

function appendCommandResult(phases: PhaseRunner, result: CommandResult): void {
  phases.append(result.stdout);
  phases.append(result.stderr);
}

function cleanupPosixGuestScript(phases: PhaseRunner, transportArgs: string[]): void {
  try {
    appendCommandResult(
      phases,
      run("prlctl", transportArgs, {
        check: false,
        quiet: true,
        timeoutMs: POSIX_GUEST_SCRIPT_CLEANUP_TIMEOUT_MS,
      }),
    );
  } catch {
    // Cleanup must not hide the command failure that made the phase useful.
  }
}

export async function runWindowsBackgroundPowerShell(
  options: WindowsBackgroundPowerShellOptions,
): Promise<void> {
  const append = options.append;
  const completedLogDrainGraceMs = Math.max(
    1,
    Math.floor(options.completedLogDrainGraceMs ?? 30_000),
  );
  const pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? 5_000));
  const runCommand = options.runCommand ?? run;
  const safeLabel = options.label.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  const nonce = `${safeLabel}-${randomUUID()}`;
  const guestRunDir = `openclaw-parallels\\${nonce}`;
  const windowsDonePath = `%WINDIR%\\Temp\\${guestRunDir}\\done`;
  const windowsLogPath = `%WINDIR%\\Temp\\${guestRunDir}\\run.log`;
  const backgroundExitPrefix = `__OPENCLAW_BACKGROUND_EXIT__:${nonce}:`;
  const backgroundDoneMarker = `__OPENCLAW_BACKGROUND_DONE__:${nonce}`;
  const deadline = Date.now() + options.timeoutMs;
  const pathsScript = `$runDir = Join-Path (Join-Path $env:WINDIR 'Temp\\openclaw-parallels') ${psSingleQuote(nonce)}
$scriptPath = Join-Path $runDir 'run.ps1'
$logPath = Join-Path $runDir 'run.log'
$donePath = Join-Path $runDir 'done'
$exitPath = Join-Path $runDir 'exit'
$pidPath = Join-Path $runDir 'pid'
function Write-OpenClawUtf8File([string]$Path, [string]$Value) {
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}`;
  const payload = `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
${pathsScript}
Write-OpenClawUtf8File $pidPath ([string]$PID)
$script:OpenClawBackgroundLogBytes = 0
function Add-OpenClawBackgroundLog {
  param([Parameter(ValueFromPipeline=$true)]$InputObject)
  process {
    $text = $InputObject | Out-String
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $remaining = [int64]${WINDOWS_BACKGROUND_LOG_MAX_BYTES} - $script:OpenClawBackgroundLogBytes
    if ($remaining -le 0) {
      return
    }
    $count = [int][Math]::Min($remaining, $bytes.Length)
    $needsBoundaryNewline = $count -eq $remaining -and $count -gt 0 -and $bytes[$count - 1] -ne 10
    if ($needsBoundaryNewline) {
      $count--
    }
    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try {
      if ($count -gt 0) {
        $stream.Write($bytes, 0, $count)
        $script:OpenClawBackgroundLogBytes += $count
      }
      if ($needsBoundaryNewline) {
        $stream.WriteByte(10)
        $script:OpenClawBackgroundLogBytes++
      }
    } finally {
      $stream.Dispose()
    }
  }
}
try {
  & {
${options.script}
  } *>&1 | Add-OpenClawBackgroundLog
  Write-OpenClawUtf8File $exitPath '0'
} catch {
  $_ | Add-OpenClawBackgroundLog
  Write-OpenClawUtf8File $exitPath '1'
} finally {
  Write-OpenClawUtf8File $donePath 'done'
}`;
  const writeArgs = [
    "exec",
    options.vmName,
    "--current-user",
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(`${pathsScript}
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
& icacls.exe $runDir /inheritance:r /grant:r "\${env:USERNAME}:(OI)(CI)(F)" "SYSTEM:(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "${safeLabel} background directory ACL setup failed" }
Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($scriptPath, [Console]::In.ReadToEnd(), [System.Text.UTF8Encoding]::new($false))
if (!(Test-Path $scriptPath)) { throw "${safeLabel} background script was not written" }`),
  ];
  let writeScript = runCommand("prlctl", writeArgs, {
    check: false,
    input: payload,
    timeoutMs: timeoutBefore(deadline, 120_000),
  });
  appendOutput(append, writeScript);
  throwIfParallelsVmStopped(options.label, writeScript);
  if (writeScript.status === 255) {
    options.onLaunchRetry?.(
      `${options.label} background script write retry after guest transport rc255`,
    );
    options.beforeLaunchAttempt?.();
    writeScript = runCommand("prlctl", writeArgs, {
      check: false,
      input: payload,
      timeoutMs: timeoutBefore(deadline, 120_000),
    });
    appendOutput(append, writeScript);
    throwIfParallelsVmStopped(options.label, writeScript);
  }
  if (writeScript.status !== 0) {
    throw new Error(
      `${options.label} background script write failed with exit code ${writeScript.status}`,
    );
  }

  let doneSeen = false;
  try {
    let launched = false;
    let lastLaunchStatus = 0;
    for (let attempt = 1; attempt <= 5 && Date.now() < deadline; attempt++) {
      options.beforeLaunchAttempt?.();
      const launch = runCommand(
        "prlctl",
        [
          "exec",
          options.vmName,
          "--current-user",
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodePowerShell(`${pathsScript}
cmd.exe /d /s /c start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$scriptPath" | Out-Null
'started'`),
        ],
        // A busy Windows guest can leave one Parallels Tools session wedged.
        // Keep polls short so a single transport cancellation cannot consume
        // the entire install timeout while the detached process continues.
        { check: false, quiet: true, timeoutMs: timeoutBefore(deadline, 8_000) },
      );
      appendOutput(append, launch);
      throwIfParallelsVmStopped(options.label, launch);
      if (launch.status === 0 && launch.stdout.includes("started")) {
        launched = true;
        break;
      }
      lastLaunchStatus = launch.status;
      if (launch.status === 0 || launch.status === 124) {
        const materialized = await waitForWindowsBackgroundMaterialized({
          append,
          deadline,
          pathsScript,
          pollIntervalMs,
          runCommand,
          vmName: options.vmName,
        });
        if (materialized) {
          launched = true;
          break;
        }
        options.onLaunchRetry?.(
          `${options.label} launch retry ${attempt}: background log/done file did not materialize`,
        );
        continue;
      }
      if (launch.stdout.includes("restoring") || launch.stderr.includes("restoring")) {
        options.onLaunchRetry?.(`${options.label} launch retry ${attempt}: VM is still restoring`);
        await sleep(5_000);
        continue;
      }
      throw new Error(`${options.label} background launch failed with exit code ${launch.status}`);
    }
    if (!launched) {
      throw new Error(
        `${options.label} background launch failed with exit code ${lastLaunchStatus}`,
      );
    }

    let completedLogDrainDeadline = 0;
    let doneFileSeen = false;
    const activeDeadline = () => (doneFileSeen ? completedLogDrainDeadline : deadline);
    while (Date.now() < activeDeadline()) {
      const doneProbe = runCommand(
        "prlctl",
        [
          "exec",
          options.vmName,
          "cmd.exe",
          "/d",
          "/s",
          "/c",
          `if exist "${windowsDonePath}" (echo done) else (echo wait)`,
        ],
        { check: false, quiet: true, timeoutMs: timeoutBefore(deadline, 5_000) },
      );
      appendOutput(append, doneProbe);
      throwIfParallelsVmStopped(options.label, doneProbe);
      if (doneProbe.stdout.split(/\r?\n/u).some((line) => line.trim() === "done")) {
        doneFileSeen = true;
        completedLogDrainDeadline ||= Date.now() + completedLogDrainGraceMs;
      } else {
        await sleep(pollIntervalMs);
        continue;
      }

      const poll = runCommand(
        "prlctl",
        [
          "exec",
          options.vmName,
          "cmd.exe",
          "/d",
          "/s",
          "/c",
          `if exist "${windowsDonePath}" (type "%WINDIR%\\Temp\\${guestRunDir}\\run.log" & for /f "usebackq delims=" %A in ("%WINDIR%\\Temp\\${guestRunDir}\\exit") do @echo ${backgroundExitPrefix}%A & echo ${backgroundDoneMarker}) else (echo wait)`,
        ],
        { check: false, quiet: true, timeoutMs: timeoutBefore(activeDeadline(), 30_000) },
      );
      appendOutput(append, poll);
      throwIfParallelsVmStopped(options.label, poll);
      if (hasControlLine(poll.stdout, backgroundDoneMarker)) {
        doneSeen = true;
        const backgroundExit = findControlValue(poll.stdout, backgroundExitPrefix) ?? "0";
        if (backgroundExit !== "0" || (poll.status !== 0 && poll.status !== 124)) {
          throw new Error(`${options.label} failed`);
        }
        return;
      }
      await sleep(Math.min(pollIntervalMs, 100));
    }
    if (doneSeen) {
      throw new Error(`${options.label} completed but log drain timed out`);
    }
    throw new Error(`${options.label} timed out`);
  } finally {
    cleanupWindowsBackground(options.vmName, pathsScript, windowsLogPath, runCommand, {
      append,
      captureLog: !doneSeen,
      stopProcessTree: !doneSeen,
    });
  }
}

function findControlValue(output: string, prefix: string): string | undefined {
  const line = output.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

function hasControlLine(output: string, marker: string): boolean {
  return output.split(/\r?\n/u).some((entry) => entry.trimEnd() === marker);
}

async function waitForWindowsBackgroundMaterialized(params: {
  append?: (chunk: string | Uint8Array) => void;
  deadline: number;
  pathsScript: string;
  pollIntervalMs: number;
  runCommand: typeof run;
  vmName: string;
}): Promise<boolean> {
  const materializeDeadline = Math.min(Date.now() + 45_000, params.deadline);
  while (Date.now() < materializeDeadline) {
    const result = params.runCommand(
      "prlctl",
      [
        "exec",
        params.vmName,
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(`${params.pathsScript}
if ((Test-Path $pidPath) -or (Test-Path $donePath)) {
  'materialized'
}`),
      ],
      { check: false, quiet: true, timeoutMs: timeoutBefore(materializeDeadline, 15_000) },
    );
    appendOutput(params.append, result);
    throwIfParallelsVmStopped("Windows background launch", result);
    if (result.stdout.includes("materialized")) {
      return true;
    }
    await sleep(Math.min(params.pollIntervalMs, Math.max(1, materializeDeadline - Date.now())));
  }
  return false;
}

function cleanupWindowsBackground(
  vmName: string,
  pathsScript: string,
  windowsLogPath: string,
  runCommand: typeof run,
  options: {
    append?: (chunk: string | Uint8Array) => void;
    captureLog: boolean;
    stopProcessTree: boolean;
  },
): void {
  const stopProcessTree = options.stopProcessTree
    ? `function Stop-OpenClawBackgroundProcessTree([int]$ProcessId) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-OpenClawBackgroundProcessTree ([int]$_.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
if (Test-Path $pidPath) {
  $backgroundPid = (Get-Content -Path $pidPath -Raw).Trim()
  if ($backgroundPid) {
    Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)
  }
}
`
    : "";
  runCommand(
    "prlctl",
    [
      "exec",
      vmName,
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(`${pathsScript}
${stopProcessTree}`),
    ],
    { check: false, quiet: true, timeoutMs: 30_000 },
  );
  if (options.captureLog) {
    const log = runCommand(
      "prlctl",
      [
        "exec",
        vmName,
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        `if exist "${windowsLogPath}" type "${windowsLogPath}"`,
      ],
      { check: false, quiet: true, timeoutMs: 30_000 },
    );
    appendOutput(options.append, log);
  }
  runCommand(
    "prlctl",
    [
      "exec",
      vmName,
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(`${pathsScript}
Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath -Force -ErrorAction SilentlyContinue
Remove-Item -Path $runDir -Recurse -Force -ErrorAction SilentlyContinue`),
    ],
    { check: false, quiet: true, timeoutMs: 30_000 },
  );
}

export class LinuxGuest {
  constructor(
    private vmName: string,
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: GuestExecOptions = {}): string {
    const result = run("prlctl", this.transportArgs(args), {
      check: false,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    throwIfFailed("Linux guest command", result, options.check);
    return result.stdout.trim();
  }

  private transportArgs(args: string[]): string[] {
    return ["exec", this.vmName, "/usr/bin/env", "HOME=/root", "OPENCLAW_ALLOW_ROOT=1", ...args];
  }

  bash(script: string): string {
    const scriptPath = `/tmp/${guestScriptName("sh")}`;
    try {
      const write = run("prlctl", this.transportArgs(["dd", `of=${scriptPath}`, "bs=1048576"]), {
        check: false,
        input: `umask 022\n${script}`,
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(),
      });
      appendCommandResult(this.phases, write);
      throwIfFailed("Linux guest script write", write, undefined);
      return this.exec(["bash", scriptPath]);
    } finally {
      cleanupPosixGuestScript(this.phases, this.transportArgs(["/bin/rm", "-f", scriptPath]));
    }
  }
}

interface MacosGuestOptions extends GuestExecOptions {
  env?: Record<string, string>;
}

export class MacosGuest {
  constructor(
    private input: {
      vmName: string;
      getUser: () => string;
      getTransport: () => "current-user" | "sudo";
      resolveDesktopHome: (user: string) => string;
      path: string;
    },
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: MacosGuestOptions = {}): string {
    return this.run(args, options).stdout.trim();
  }

  private transportArgs(args: string[], env: Record<string, string> = {}): string[] {
    const envArgs = Object.entries({ PATH: this.input.path, ...env }).map(
      ([key, value]) => `${key}=${value}`,
    );
    const user = this.input.getUser();
    return this.input.getTransport() === "sudo"
      ? [
          "exec",
          this.input.vmName,
          "/usr/bin/sudo",
          "-H",
          "-u",
          user,
          "/usr/bin/env",
          `HOME=${this.input.resolveDesktopHome(user)}`,
          `USER=${user}`,
          `LOGNAME=${user}`,
          ...envArgs,
          ...args,
        ]
      : ["exec", this.input.vmName, "--current-user", "/usr/bin/env", ...envArgs, ...args];
  }

  run(args: string[], options: MacosGuestOptions = {}): CommandResult {
    const result = run("prlctl", this.transportArgs(args, options.env), {
      check: false,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    throwIfGuestSessionUnavailable("macOS guest command", result, options.check);
    throwIfFailed("macOS guest command", result, options.check);
    return result;
  }

  sh(script: string, env: Record<string, string> = {}): string {
    const scriptPath = `/tmp/${guestScriptName("sh")}`;
    try {
      this.exec(["/bin/dd", `of=${scriptPath}`, "bs=1048576"], {
        input: `umask 022\n${script}`,
      });
      return this.exec(["/bin/bash", scriptPath], { env });
    } finally {
      cleanupPosixGuestScript(this.phases, this.transportArgs(["/bin/rm", "-f", scriptPath]));
    }
  }
}

export class WindowsGuest {
  constructor(
    private vmName: string,
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: GuestExecOptions = {}): string {
    return this.run(args, options).stdout.trim();
  }

  run(args: string[], options: GuestExecOptions = {}): CommandResult {
    const result = run("prlctl", ["exec", this.vmName, "--current-user", ...args], {
      check: false,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    throwIfFailed("Windows guest command", result, options.check);
    return result;
  }

  powershell(script: string, options: GuestExecOptions = {}): string {
    const scriptName = guestScriptName("ps1");
    const writeScript = `$scriptPath = Join-Path $env:TEMP ${JSON.stringify(scriptName)}
[System.IO.File]::WriteAllText($scriptPath, [Console]::In.ReadToEnd(), [System.Text.UTF8Encoding]::new($false))`;
    const write = run(
      "prlctl",
      [
        "exec",
        this.vmName,
        "--current-user",
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(writeScript),
      ],
      {
        input: script,
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(120_000),
      },
    );
    this.phases.append(write.stdout);
    this.phases.append(write.stderr);
    const scriptPath = `%TEMP%\\${scriptName}`;
    try {
      return this.exec(
        [
          "cmd.exe",
          "/d",
          "/s",
          "/c",
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        ],
        options,
      );
    } finally {
      this.exec(["cmd.exe", "/d", "/s", "/c", `del /F /Q "${scriptPath}"`], {
        check: false,
        timeoutMs: 30_000,
      });
    }
  }
}
