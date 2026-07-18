// Verifies shell selection, PATH lookup, and platform-specific shell helpers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  buildShellCommandInvocation,
  detectRuntimeShell,
  getBashShellConfig,
  getBashShellEnv,
  getShellConfig,
  sanitizeBinaryOutput,
} from "./shell-utils.js";

const isWin = process.platform === "win32";

describe("sanitizeBinaryOutput", () => {
  it("removes ANSI wrappers while retaining printable output", () => {
    expect(sanitizeBinaryOutput("\u001b[31mred\u001b[0m")).toBe("red");
    expect(sanitizeBinaryOutput("\u009b31mred\u009b0m")).toBe("red");
  });

  it("preserves unterminated OSC and pending CSI text at chunk boundaries", () => {
    expect(sanitizeBinaryOutput("\u001b]unterminated")).toBe("\\x1b]unterminated");
    expect(sanitizeBinaryOutput("before\u009b31;")).toBe("before\\x9b31;");
    expect(sanitizeBinaryOutput("\u001b[") + sanitizeBinaryOutput("Ksecret")).toBe("\\x1b[Ksecret");
  });

  it("applies caller control policy while CSI remains active", () => {
    // SOH executes independently, then "d" terminates CSI as its final byte.
    expect(sanitizeBinaryOutput("\u009b\u0001done")).toBe("\\x01one");
    expect(sanitizeBinaryOutput("\u009b31\u0018done")).toBe("done");
    expect(sanitizeBinaryOutput("\u001b[31\u001adone")).toBe("done");
  });

  it("escapes residual C0, DEL, and C1 controls", () => {
    expect(sanitizeBinaryOutput("a\u0000\u0007\u007f\u0080b\t\n")).toBe(
      "a\\x00\\x07\\x7f\\x80b\t\n",
    );
  });
});

function createTempCommandDir(
  tempDirs: string[],
  files: Array<{ name: string; executable?: boolean }>,
): string {
  // Temporary PATH entries model available shell binaries and permissions.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-"));
  tempDirs.push(dir);
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, "");
    fs.chmodSync(filePath, file.executable === false ? 0o644 : 0o755);
  }
  return dir;
}

type ShellConfig = ReturnType<typeof getBashShellConfig>;

describe("getShellConfig", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv(["SHELL", "PATH"]);
    if (!isWin) {
      process.env.SHELL = "/usr/bin/fish";
    }
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (isWin) {
    it("uses PowerShell on Windows", () => {
      const { shell, args } = getShellConfig();
      const normalized = shell.toLowerCase();
      if (normalized.includes("powershell")) {
        expect(normalized).toContain("powershell");
      } else {
        expect(normalized).toContain("pwsh");
      }
      expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    });
    return;
  }

  it("prefers bash when fish is default and bash is on PATH", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
    expect(args).toEqual(["--noprofile", "--norc", "-c"]);
  });

  it("falls back to sh when fish is default and bash is missing", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toEqual(["-c"]);
  });

  it("falls back to env shell when fish is default and no sh is available", () => {
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/usr/bin/fish");
    expect(args).toEqual(["--no-config", "-c"]);
  });

  it("uses startup-suppressed args for zsh env shells", () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/bin/zsh");
    expect(args).toEqual(["-f", "-c"]);
  });

  it("uses startup-suppressed args for bash env shells", () => {
    process.env.SHELL = "/bin/bash";
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/bin/bash");
    expect(args).toEqual(["--noprofile", "--norc", "-c"]);
  });

  it("uses sh when SHELL is unset", () => {
    delete process.env.SHELL;
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("sh");
    expect(args).toEqual(["-c"]);
  });

  it("uses an explicit custom shell path through the same resolver", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "zsh" }]);
    const shellPath = path.join(binDir, "zsh");

    expect(getShellConfig(shellPath)).toEqual({
      shell: shellPath,
      args: ["-f", "-c"],
      commandTransport: "argv",
    });
  });

  it("rejects a missing explicit custom shell path", () => {
    expect(() => getShellConfig(path.join(os.tmpdir(), "missing-openclaw-shell"))).toThrow(
      "Custom shell path not found",
    );
  });

  it("falls back to sh on PATH when SHELL is /usr/bin/false", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toEqual(["-c"]);
  });

  it("falls back to sh on PATH when SHELL is /sbin/nologin", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.SHELL = "/sbin/nologin";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toEqual(["-c"]);
  });

  it("falls back to startup-suppressed bash on PATH when SHELL is a placeholder", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
    expect(args).toEqual(["--noprofile", "--norc", "-c"]);
  });

  it("falls back to bare sh when SHELL is a placeholder and no sh is on PATH", () => {
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("sh");
    expect(args).toEqual(["-c"]);
  });
});

describe("getBashShellConfig", () => {
  const tempDirs: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["ProgramFiles", "ProgramFiles(x86)", "PATH", "Path"]);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds Git Bash under ProgramFiles", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-bash-"));
    tempDirs.push(programFiles);
    const bashDir = path.join(programFiles, "Git", "bin");
    fs.mkdirSync(bashDir, { recursive: true });
    const bashPath = path.join(bashDir, "bash.exe");
    fs.writeFileSync(bashPath, "");

    process.env.ProgramFiles = programFiles;
    process.env.PATH = "";

    expect(getBashShellConfig()).toEqual({
      shell: bashPath,
      args: ["-c"],
      commandTransport: "argv",
    });
  });

  it("prepends coreutils for a standard Git for Windows install", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-bash-env-"));
    tempDirs.push(programFiles);
    const gitRoot = path.join(programFiles, "Git");
    const bashPath = path.join(gitRoot, "bin", "bash.exe");
    const usrBin = path.join(gitRoot, "usr", "bin");
    fs.mkdirSync(path.dirname(bashPath), { recursive: true });
    fs.mkdirSync(path.join(gitRoot, "cmd"), { recursive: true });
    fs.mkdirSync(usrBin, { recursive: true });
    fs.writeFileSync(bashPath, "");
    fs.writeFileSync(path.join(gitRoot, "cmd", "git.exe"), "");
    process.env.PATH = path.join(programFiles, "OtherBin");

    const env = getBashShellEnv(bashPath);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(usrBin);
    expect(env.PATH).toContain(process.env.PATH);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
  });

  it("recognizes portable Git for Windows installs", () => {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-portable-git-"));
    tempDirs.push(gitRoot);
    const bashPath = path.join(gitRoot, "usr", "bin", "bash.exe");
    const usrBin = path.dirname(bashPath);
    fs.mkdirSync(usrBin, { recursive: true });
    fs.mkdirSync(path.join(gitRoot, "cmd"), { recursive: true });
    fs.writeFileSync(bashPath, "");
    fs.writeFileSync(path.join(gitRoot, "cmd", "git.exe"), "");

    expect(getBashShellEnv(bashPath).PATH?.split(path.delimiter)[0]).toBe(usrBin);
  });

  it("leaves unrelated MSYS2 installs unchanged", () => {
    const msysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-msys2-"));
    tempDirs.push(msysRoot);
    const bashPath = path.join(msysRoot, "usr", "bin", "bash.exe");
    fs.mkdirSync(path.dirname(bashPath), { recursive: true });
    fs.writeFileSync(bashPath, "");
    process.env.PATH = path.join(msysRoot, "ucrt64", "bin");

    const env = getBashShellEnv(bashPath);

    expect(env.PATH?.split(path.delimiter)[0]).not.toBe(path.dirname(bashPath));
    expect(env.PATH).toContain(process.env.PATH);
  });

  it.each(["System32", "Sysnative"])(
    "uses stdin transport for the legacy %s WSL launcher",
    (systemDirectory) => {
      const shellPath = `C:\\Windows\\${systemDirectory}\\bash.exe`;
      vi.spyOn(fs, "existsSync").mockImplementation((candidate) => String(candidate) === shellPath);

      expect(getBashShellConfig(shellPath)).toEqual({
        shell: shellPath,
        args: ["-s"],
        commandTransport: "stdin",
      });
    },
  );

  it("builds a stdin invocation for the legacy WSL launcher", () => {
    const config: ShellConfig = {
      shell: "C:\\Windows\\System32\\bash.exe",
      args: ["-s"],
      commandTransport: "stdin",
    };

    expect(buildShellCommandInvocation("printf ready", config)).toEqual({
      argv: [config.shell, "-s"],
      input: "printf ready",
      stdin: "pipe",
    });
  });

  it("builds an argv invocation for regular shells", () => {
    const config: ShellConfig = {
      shell: "/bin/bash",
      args: ["-c"],
      commandTransport: "argv",
    };

    expect(buildShellCommandInvocation("printf ready", config)).toEqual({
      argv: [config.shell, "-c", "printf ready"],
      stdin: "ignore",
    });
  });
});

describe("getBashShellEnv", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "Path"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
  });

  it("returns an env object with the OpenClaw bin dir on PATH", () => {
    process.env.PATH = "/usr/bin";
    const env = getBashShellEnv();

    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain(".openclaw");
  });

  it("collapses case-insensitive PATH duplicates before Windows spawn", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const env = getBashShellEnv(undefined, { PATH: "/selected", Path: "/discarded" });

    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toContain("/selected");
    expect(env.PATH).not.toContain("/discarded");
  });

  it.runIf(isWin)("passes one canonical PATH entry to a child process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => key.toLowerCase() === 'path')))",
      ],
      { encoding: "utf8", env: getBashShellEnv() },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["PATH"]);
  });
});

describe("detectRuntimeShell", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_SHELL",
      "SHELL",
      "POWERSHELL_DISTRIBUTION_CHANNEL",
      "BASH_VERSION",
      "ZSH_VERSION",
      "FISH_VERSION",
      "KSH_VERSION",
      "NU_VERSION",
      "NUSHELL_VERSION",
    ]);
    delete process.env.OPENCLAW_SHELL;
    delete process.env.POWERSHELL_DISTRIBUTION_CHANNEL;
    delete process.env.BASH_VERSION;
    delete process.env.ZSH_VERSION;
    delete process.env.FISH_VERSION;
    delete process.env.KSH_VERSION;
    delete process.env.NU_VERSION;
    delete process.env.NUSHELL_VERSION;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  if (!isWin) {
    it("ignores non-interactive SHELL placeholders and falls through to runtime hints", () => {
      process.env.SHELL = "/usr/bin/false";
      process.env.BASH_VERSION = "5.2.0";

      expect(detectRuntimeShell()).toBe("bash");
    });
  }
});

describe("getShellConfig on Windows", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv([
      "ProgramFiles",
      "PROGRAMFILES",
      "ProgramW6432",
      "SystemRoot",
      "WINDIR",
      "PATH",
    ]);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers PowerShell 7 in ProgramFiles", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    tempDirs.push(base);
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(getShellConfig().shell).toBe(pwsh7Path);
  });

  it("prefers ProgramW6432 PowerShell 7 when ProgramFiles lacks pwsh", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const programW6432 = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pw6432-"));
    tempDirs.push(programFiles, programW6432);
    const pwsh7Dir = path.join(programW6432, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = programFiles;
    process.env.ProgramW6432 = programW6432;
    process.env.PATH = "";
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(getShellConfig().shell).toBe(pwsh7Path);
  });

  it("finds pwsh on PATH when not in standard install locations", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bin-"));
    tempDirs.push(programFiles, binDir);
    const pwshPath = path.join(binDir, "pwsh");
    fs.writeFileSync(pwshPath, "");
    fs.chmodSync(pwshPath, 0o755);

    process.env.ProgramFiles = programFiles;
    process.env.PATH = binDir;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(getShellConfig().shell).toBe(pwshPath);
  });

  it("falls back to Windows PowerShell 5.1 path when pwsh is unavailable", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sysroot-"));
    tempDirs.push(programFiles, sysRoot);
    const ps51Dir = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0");
    fs.mkdirSync(ps51Dir, { recursive: true });
    const ps51Path = path.join(ps51Dir, "powershell.exe");
    fs.writeFileSync(ps51Path, "");

    process.env.ProgramFiles = programFiles;
    process.env.SystemRoot = sysRoot;
    process.env.PATH = "";
    delete process.env.ProgramW6432;
    delete process.env.WINDIR;

    expect(getShellConfig().shell).toBe(ps51Path);
  });
});
