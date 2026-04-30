import { run } from "./host-command.ts";
import type { PhaseRunner } from "./phase-runner.ts";
import { encodePowerShell } from "./powershell.ts";
import type { CommandResult } from "./types.ts";

export interface GuestExecOptions {
  check?: boolean;
  input?: string;
  timeoutMs?: number;
}

export class LinuxGuest {
  constructor(
    private vmName: string,
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: GuestExecOptions = {}): string {
    const result = run("prlctl", ["exec", this.vmName, "/usr/bin/env", "HOME=/root", ...args], {
      check: options.check,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    return result.stdout.trim();
  }

  bash(script: string): string {
    const scriptPath = `/tmp/openclaw-parallels-${process.pid}-${Date.now()}.sh`;
    const write = run(
      "prlctl",
      ["exec", this.vmName, "/usr/bin/env", "HOME=/root", "dd", `of=${scriptPath}`, "bs=1048576"],
      {
        input: script,
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
      check: options.check,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    return result;
  }

  sh(script: string, env: Record<string, string> = {}): string {
    const scriptPath = `/tmp/openclaw-parallels-${process.pid}-${Date.now()}.sh`;
    this.exec(["/bin/dd", `of=${scriptPath}`, "bs=1048576"], { input: script });
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
      check: options.check,
      input: options.input,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
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
