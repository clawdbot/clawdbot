// Covers executable path detection and PATH lookup helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  isRegularFile,
  resolveExecutable,
  resolveExecutableFromPathEnv,
  resolveExecutablePath,
  resolveExecutablePathCandidate,
} from "./executable-path.js";

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("executable path helpers", () => {
  it("detects regular files and rejects directories", async () => {
    await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
      const execPath = path.join(base, "tool");
      const filePath = path.join(base, "plain.txt");
      const dirPath = path.join(base, "dir");
      await fs.writeFile(execPath, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.chmod(execPath, 0o755);
      await fs.writeFile(filePath, "nope", "utf8");
      await fs.mkdir(dirPath);

      expect(isRegularFile(execPath)).toBe(true);
      expect(isRegularFile(filePath)).toBe(true);
      expect(isRegularFile(dirPath)).toBe(false);
      expect(isRegularFile(path.join(base, "missing"))).toBe(false);
    });
  });

  it("resolves executables from PATH entries and cwd-relative paths", async () => {
    await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
      const binDir = path.join(base, "bin");
      const cwd = path.join(base, "cwd");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(cwd, { recursive: true });

      const pathTool = path.join(binDir, "runner");
      const cwdTool = path.join(cwd, "local-tool");
      await fs.writeFile(pathTool, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.writeFile(cwdTool, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.chmod(pathTool, 0o755);
      await fs.chmod(cwdTool, 0o755);

      expect(resolveExecutableFromPathEnv("runner", `${binDir}${path.delimiter}/usr/bin`)).toBe(
        pathTool,
      );
      expect(resolveExecutableFromPathEnv("missing", binDir)).toBeUndefined();
      expect(resolveExecutablePath("./local-tool", { cwd })).toBe(cwdTool);
      expect(resolveExecutablePath("runner", { env: { PATH: binDir } })).toBe(pathTool);
      expect(resolveExecutablePath("missing", { env: { PATH: binDir } })).toBeUndefined();
    });
  });

  it("resolves absolute, home-relative, and Path-cased env executables", async () => {
    await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
      const homeDir = path.join(base, "home");
      const binDir = path.join(base, "bin");
      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });

      const homeTool = path.join(homeDir, "home-tool");
      const absoluteTool = path.join(base, "absolute-tool");
      const pathTool = path.join(binDir, "runner");
      await fs.writeFile(homeTool, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.writeFile(absoluteTool, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.writeFile(pathTool, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.chmod(homeTool, 0o755);
      await fs.chmod(absoluteTool, 0o755);
      await fs.chmod(pathTool, 0o755);

      expect(resolveExecutablePath(absoluteTool)).toBe(absoluteTool);
      expect(
        path.normalize(resolveExecutablePath("~/home-tool", { env: { HOME: homeDir } }) ?? ""),
      ).toBe(path.normalize(homeTool));
      expect(path.normalize(resolveExecutablePath("runner", { env: { Path: binDir } }) ?? "")).toBe(
        path.normalize(pathTool),
      );
      expect(resolveExecutablePath("~/missing-tool", { env: { HOME: homeDir } })).toBeUndefined();
    });
  });

  it.runIf(process.platform !== "win32")("normalizes POSIX absolute executable candidates", () => {
    expect(resolveExecutablePathCandidate("/usr/bin/../../bin/sh")).toBe("/bin/sh");
    expect(resolveExecutablePathCandidate("/usr/bin/./env")).toBe("/usr/bin/env");
  });

  it.runIf(process.platform === "win32")(
    "normalizes Windows absolute executable candidates",
    () => {
      expect(
        resolveExecutablePathCandidate(String.raw`C:\Tools\..\..\Windows\System32\cmd.exe`),
      ).toBe(String.raw`C:\Windows\System32\cmd.exe`);
      expect(resolveExecutablePathCandidate(String.raw`C:\Tools\.\runner.exe`)).toBe(
        String.raw`C:\Tools\runner.exe`,
      );
    },
  );

  it("does not treat drive-less rooted windows paths as cwd-relative executables", () => {
    if (process.platform !== "win32") {
      return;
    }

    expect(
      resolveExecutablePath(String.raw`:\Users\demo\AI\system\openclaw\git.exe`, {
        cwd: String.raw`C:\Users\demo\AI\system\openclaw`,
      }),
    ).toBeUndefined();
    expect(
      resolveExecutablePath(String.raw`:/Users/demo/AI/system/openclaw/git.exe`, {
        cwd: String.raw`C:\Users\demo\AI\system\openclaw`,
      }),
    ).toBeUndefined();
  });
});

describe("resolveExecutable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cmd unchanged on non-Windows platforms", () => {
    withMockedPlatform("linux", () => {
      expect(resolveExecutable("gcloud")).toBe("gcloud");
    });
  });

  it("returns cmd unchanged when it already carries a known PATHEXT extension on Windows", () => {
    withMockedPlatform("win32", () => {
      expect(resolveExecutable("gcloud.cmd")).toBe("gcloud.cmd");
      expect(resolveExecutable("gcloud.exe")).toBe("gcloud.exe");
      expect(resolveExecutable("gcloud.bat")).toBe("gcloud.bat");
      expect(resolveExecutable("gcloud.com")).toBe("gcloud.com");
    });
  });

  it("resolves to the first .cmd result from PATH on Windows without executing where.exe", async () => {
    await withMockedPlatform("win32", async () => {
      await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
        const binDir = path.join(base, "bin");
        await fs.mkdir(binDir, { recursive: true });
        const cmdPath = path.join(binDir, "gcloud.cmd");
        const exePath = path.join(binDir, "gcloud.exe");
        await fs.writeFile(cmdPath, "@echo off\n", "utf8");
        await fs.writeFile(exePath, "exe\n", "utf8");

        const originalPath = process.env.PATH;
        const originalPathext = process.env.PATHEXT;
        process.env.PATH = binDir;
        process.env.PATHEXT = ".EXE;.CMD;.BAT;.COM";
        try {
          expect(resolveExecutable("gcloud")).toBe(cmdPath);
        } finally {
          restoreEnvValue("PATH", originalPath);
          restoreEnvValue("PATHEXT", originalPathext);
        }
      });
    });
  });

  it("falls back to .exe when no .cmd match exists on Windows", async () => {
    await withMockedPlatform("win32", async () => {
      await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
        const binDir = path.join(base, "bin");
        await fs.mkdir(binDir, { recursive: true });
        const exePath = path.join(binDir, "tailscale.exe");
        await fs.writeFile(exePath, "exe\n", "utf8");

        const originalPath = process.env.PATH;
        process.env.PATH = binDir;
        try {
          expect(resolveExecutable("tailscale")).toBe(exePath);
        } finally {
          restoreEnvValue("PATH", originalPath);
        }
      });
    });
  });

  it("falls back to first PATH result when no .cmd or .exe match exists on Windows", async () => {
    await withMockedPlatform("win32", async () => {
      await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
        const binDir = path.join(base, "bin");
        await fs.mkdir(binDir, { recursive: true });
        const ps1Path = path.join(binDir, "gcloud.ps1");
        await fs.writeFile(ps1Path, "Write-Output ok\n", "utf8");

        const originalPath = process.env.PATH;
        const originalPathext = process.env.PATHEXT;
        process.env.PATH = binDir;
        process.env.PATHEXT = ".PS1";
        try {
          expect(resolveExecutable("gcloud")).toBe(ps1Path);
        } finally {
          restoreEnvValue("PATH", originalPath);
          restoreEnvValue("PATHEXT", originalPathext);
        }
      });
    });
  });

  it("returns original cmd when no PATH match exists on Windows", () => {
    withMockedPlatform("win32", () => {
      expect(resolveExecutable("gog")).toBe("gog");
    });
  });
});

describe("caller env PATHEXT propagation", () => {
  it("resolveExecutableFromPathEnv uses caller env PATHEXT on Windows", async () => {
    const orig = process.env.PATHEXT;
    process.env.PATHEXT = ".TXT";
    try {
      await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
        const binDir = path.join(base, "bin");
        await fs.mkdir(binDir, { recursive: true });

        const ps1Path = path.join(binDir, "tool.ps1");
        await fs.writeFile(ps1Path, 'Write-Output "ok"\n', "utf8");
        // On Windows the delimiter is ";", build pathEnv accordingly for mocked platform
        const pathEnv = `${binDir};${process.env.PATH ?? ""}`;

        withMockedPlatform("win32", () => {
          // Caller env has .PS1, process.env.PATHEXT does not
          const result = resolveExecutableFromPathEnv("tool", pathEnv, { PATHEXT: ".PS1" });
          expect(result).toBe(ps1Path);
        });
      });
    } finally {
      restoreEnvValue("PATHEXT", orig);
    }
  });

  it("keeps PATHEXT checks for non-native explicit PATH extensions", async () => {
    await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
      const binDir = path.join(base, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const exePath = path.join(binDir, "tool.exe");
      const ps1Path = path.join(binDir, "tool.ps1");
      await fs.writeFile(exePath, "exe\n", "utf8");
      await fs.writeFile(ps1Path, 'Write-Output "ok"\n', "utf8");

      withMockedPlatform("win32", () => {
        expect(resolveExecutableFromPathEnv("tool.exe", binDir, { PATHEXT: ".CMD" })).toBe(exePath);
        expect(
          resolveExecutableFromPathEnv("tool.ps1", binDir, { PATHEXT: ".EXE" }),
        ).toBeUndefined();
        expect(resolveExecutableFromPathEnv("tool.ps1", binDir, { PATHEXT: ".PS1" })).toBe(ps1Path);
      });
    });
  });

  it("resolveExecutablePath with path separator passes env to PATHEXT check on Windows", async () => {
    const orig = process.env.PATHEXT;
    process.env.PATHEXT = ".TXT";
    try {
      await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
        const ps1File = path.join(base, "script.ps1");
        await fs.writeFile(ps1File, 'Write-Output "ok"\n', "utf8");

        withMockedPlatform("win32", () => {
          // Passing an absolute path (has separator) with custom env
          const result = resolveExecutablePath(ps1File, { env: { PATHEXT: ".PS1" } });
          expect(result).toBe(ps1File);
        });
      });
    } finally {
      restoreEnvValue("PATHEXT", orig);
    }
  });

  it("resolveExecutablePath without path separator falls back to PATH env", async () => {
    const orig = process.env.PATHEXT;
    process.env.PATHEXT = ".TXT";
    try {
      await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
        const binDir = path.join(base, "bin");
        await fs.mkdir(binDir, { recursive: true });
        const ps1Path = path.join(binDir, "runner.ps1");
        await fs.writeFile(ps1Path, 'Write-Output "ok"\n', "utf8");

        withMockedPlatform("win32", () => {
          const result = resolveExecutablePath("runner", {
            env: { PATH: binDir, PATHEXT: ".PS1" },
          });
          expect(result).toBe(ps1Path);
        });
      });
    } finally {
      restoreEnvValue("PATHEXT", orig);
    }
  });

  it("resolveExecutablePath with path separator falls back to process.env when no caller env given", async () => {
    await withTempDir({ prefix: "openclaw-exec-path-" }, async (base) => {
      const ps1File = path.join(base, "script.ps1");
      await fs.writeFile(ps1File, 'Write-Output "ok"\n', "utf8");

      const orig = process.env.PATHEXT;
      process.env.PATHEXT = ".TXT";
      try {
        withMockedPlatform("win32", () => {
          // No caller env given, process.env.PATHEXT is .TXT -> .PS1 not matched -> undefined
          expect(resolveExecutablePath(ps1File)).toBeUndefined();
        });
      } finally {
        restoreEnvValue("PATHEXT", orig);
      }
    });
  });
});
