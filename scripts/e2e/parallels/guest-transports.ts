import { run } from "./host-command.ts";
import type { PhaseRunner } from "./phase-runner.ts";
import { encodePowerShell, psSingleQuote } from "./powershell.ts";
import type { CommandResult } from "./types.ts";

export interface GuestExecOptions {
  check?: boolean;
  input?: string;
  timeoutMs?: number;
}

export interface WindowsBackgroundPowerShellOptions {
  append?: (chunk: string | Uint8Array) => void;
  beforeLaunchAttempt?: () => void;
  label: string;
  onLaunchRetry?: (message: string) => void;
  script: string;
  timeoutMs: number;
  vmName: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfFailed(label: string, result: CommandResult, check: boolean | undefined): void {
  if (check === false || result.status === 0) {
    return;
  }
  throw new Error(`${label} failed with exit code ${result.status}`);
}

export async function runWindowsBackgroundPowerShell(
  options: WindowsBackgroundPowerShellOptions,
): Promise<void> {
  const append = options.append;
  const safeLabel = options.label.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  const nonce = `${safeLabel}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const fileBase = `openclaw-parallels-${nonce}`;
  const pathsScript = `$base = Join-Path $env:TEMP ${psSingleQuote(fileBase)}
$scriptPath = "$base.ps1"
$logPath = "$base.log"
$donePath = "$base.done"
$exitPath = "$base.exit"`;
  const payload = `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
${pathsScript}
try {
  & {
${options.script}
  } *>&1 | ForEach-Object { $_ | Out-String | Add-Content -Path $logPath -Encoding UTF8 }
  Set-Content -Path $exitPath -Value '0' -Encoding UTF8
} catch {
  $_ | Out-String | Add-Content -Path $logPath -Encoding UTF8
  Set-Content -Path $exitPath -Value '1' -Encoding UTF8
} finally {
  Set-Content -Path $donePath -Value 'done' -Encoding UTF8
}`;
  const writeScript = run(
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
Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($scriptPath, [Console]::In.ReadToEnd(), [System.Text.UTF8Encoding]::new($false))
if (!(Test-Path $scriptPath)) { throw "${safeLabel} background script was not written" }`),
    ],
    { check: false, input: payload, timeoutMs: Math.min(options.timeoutMs, 120_000) },
  );
  appendOutput(append, writeScript);
  if (writeScript.status !== 0) {
    throw new Error(
      `${options.label} background script write failed with exit code ${writeScript.status}`,
    );
  }

  const deadline = Date.now() + options.timeoutMs;
  let launched = false;
  let lastLaunchStatus = 0;
  for (let attempt = 1; attempt <= 5 && Date.now() < deadline; attempt++) {
    options.beforeLaunchAttempt?.();
    const launch = run(
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
Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath)
'started'`),
      ],
      { check: false, quiet: true, timeoutMs: timeoutBefore(deadline, 30_000) },
    );
    appendOutput(append, launch);
    if (launch.status === 0 && launch.stdout.includes("started")) {
      launched = true;
      break;
    }
    lastLaunchStatus = launch.status;
    if (launch.status === 0 || launch.status === 124) {
      const materialized = waitForWindowsBackgroundMaterialized({
        append,
        deadline,
        pathsScript,
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
    throw new Error(`${options.label} background launch failed with exit code ${lastLaunchStatus}`);
  }

  let lastLogOffset = 0;
  while (Date.now() < deadline) {
    const poll = run(
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
$offset = ${lastLogOffset}
if (Test-Path $logPath) {
  $bytes = [System.IO.File]::ReadAllBytes($logPath)
  if ($bytes.Length -gt $offset) {
    "__OPENCLAW_LOG_OFFSET__:$($bytes.Length)"
    [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
  }
}
if (Test-Path $donePath) {
  $backgroundExit = if (Test-Path $exitPath) { (Get-Content -Path $exitPath -Raw).Trim() } else { '0' }
  "__OPENCLAW_BACKGROUND_EXIT__:$backgroundExit"
  '__OPENCLAW_BACKGROUND_DONE__'
  if ($backgroundExit -ne '0') { exit 23 }
  exit 0
}`),
      ],
      { check: false, quiet: true, timeoutMs: timeoutBefore(deadline, 30_000) },
    );
    appendOutput(append, poll);
    const offsetMatch = poll.stdout.match(/__OPENCLAW_LOG_OFFSET__:(\d+)/);
    if (offsetMatch) {
      lastLogOffset = Number(offsetMatch[1]);
    }
    if (poll.stdout.includes("__OPENCLAW_BACKGROUND_DONE__")) {
      const exitMatch = poll.stdout.match(/__OPENCLAW_BACKGROUND_EXIT__:(\S+)/);
      const backgroundExit = exitMatch?.[1] ?? "0";
      if (backgroundExit !== "0" || (poll.status !== 0 && poll.status !== 124)) {
        throw new Error(`${options.label} failed`);
      }
      cleanupWindowsBackground(options.vmName, pathsScript);
      return;
    }
    await sleep(5_000);
  }
  throw new Error(`${options.label} timed out`);
}

function waitForWindowsBackgroundMaterialized(params: {
  append?: (chunk: string | Uint8Array) => void;
  deadline: number;
  pathsScript: string;
  vmName: string;
}): boolean {
  const materializeDeadline = Math.min(Date.now() + 45_000, params.deadline);
  while (Date.now() < materializeDeadline) {
    const result = run(
      "prlctl",
      [
        "exec",
        params.vmName,
        "--current-user",
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(`${params.pathsScript}
if ((Test-Path $logPath) -or (Test-Path $donePath)) {
  'materialized'
}`),
      ],
      { check: false, quiet: true, timeoutMs: timeoutBefore(materializeDeadline, 15_000) },
    );
    appendOutput(params.append, result);
    if (result.stdout.includes("materialized")) {
      return true;
    }
  }
  return false;
}

function cleanupWindowsBackground(vmName: string, pathsScript: string): void {
  run(
    "prlctl",
    [
      "exec",
      vmName,
      "--current-user",
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(`${pathsScript}
Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath -Force -ErrorAction SilentlyContinue`),
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
    const result = run(
      "prlctl",
      ["exec", this.vmName, "/usr/bin/env", "HOME=/root", "OPENCLAW_ALLOW_ROOT=1", ...args],
      {
        check: false,
        input: options.input,
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
      },
    );
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    throwIfFailed("Linux guest command", result, options.check);
    return result.stdout.trim();
  }

  bash(script: string): string {
    const scriptPath = `/tmp/openclaw-parallels-${process.pid}-${Date.now()}.sh`;
    const write = run(
      "prlctl",
      [
        "exec",
        this.vmName,
        "/usr/bin/env",
        "HOME=/root",
        "OPENCLAW_ALLOW_ROOT=1",
        "dd",
        `of=${scriptPath}`,
        "bs=1048576",
      ],
      {
        input: `umask 022\n${script}`,
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(),
      },
    );
    this.phases.append(write.stdout);
    this.phases.append(write.stderr);
    try {
      return this.exec(["bash", scriptPath]);
    } finally {
      this.exec(["rm", "-f", scriptPath], { check: false });
    }
  }
}

export interface MacosGuestOptions extends GuestExecOptions {
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

  run(args: string[], options: MacosGuestOptions = {}): CommandResult {
    const envArgs = Object.entries({ PATH: this.input.path, ...options.env }).map(
      ([key, value]) => `${key}=${value}`,
    );
    const user = this.input.getUser();
    const transportArgs =
      this.input.getTransport() === "sudo"
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
    const result = run("prlctl", transportArgs, {
      check: false,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    throwIfFailed("macOS guest command", result, options.check);
    return result;
  }

  sh(script: string, env: Record<string, string> = {}): string {
    const scriptPath = `/tmp/openclaw-parallels-${process.pid}-${Date.now()}.sh`;
    this.exec(["/bin/dd", `of=${scriptPath}`, "bs=1048576"], {
      input: `umask 022\n${script}`,
    });
    try {
      return this.exec(["/bin/bash", scriptPath], { env });
    } finally {
      this.exec(["/bin/rm", "-f", scriptPath], { check: false });
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
    const scriptName = `openclaw-parallels-${process.pid}-${Date.now()}.ps1`;
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
