import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatCompletionReloadCommand,
  formatCompletionSourceLine,
  installCompletion,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
} from "./completion-runtime.js";

describe("completion-runtime", () => {
  const originalHome = process.env.HOME;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("formats PowerShell source and reload commands with single-quoted paths", () => {
    expect(
      formatCompletionSourceLine("powershell", "openclaw", "C:\\Users\\Ada\\open'claw.ps1"),
    ).toBe(". 'C:\\Users\\Ada\\open''claw.ps1'");
    expect(formatCompletionReloadCommand("powershell", "C:\\Users\\Ada\\profile.ps1")).toBe(
      ". 'C:\\Users\\Ada\\profile.ps1'",
    );
  });

  it("detects PowerShell shell names from Windows paths", () => {
    expect(resolveShellFromEnv({ SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })).toBe(
      "powershell",
    );
    expect(
      resolveShellFromEnv({
        SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    ).toBe("powershell");
  });

  it("resolves Windows PowerShell and pwsh profile directories", () => {
    expect(
      resolveCompletionProfilePath("powershell", {
        env: {
          SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          USERPROFILE: "C:\\Users\\Ada",
        },
        homeDir: () => "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Users\\Ada",
        "Documents",
        "PowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    );
    expect(
      resolveCompletionProfilePath("powershell", {
        env: {
          SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          USERPROFILE: "C:\\Users\\Ada",
        },
        homeDir: () => "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Users\\Ada",
        "Documents",
        "WindowsPowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    );
  });

  it("installs PowerShell completion into the concrete profile path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));

    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# powershell completion\n", "utf-8");

      await installCompletion("powershell", true, "openclaw");

      const profilePath = resolveCompletionProfilePath("powershell");
      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toBe(`# OpenClaw Completion\n. '${cachePath}'\n`);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
