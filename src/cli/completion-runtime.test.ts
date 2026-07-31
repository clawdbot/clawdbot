// Completion runtime tests cover shell completion generation and runtime file writes.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "./completion-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withBashCompletionHome(
  run: (paths: { homeDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const homeDir = tempDirs.make("openclaw-bash-completion-home-");
  const stateDir = tempDirs.make("openclaw-bash-completion-state-");

  await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
    await run({ homeDir, stateDir });
  });
}

describe("completion-runtime", () => {
  it("resolves the documented Bash login profile when .bashrc is absent", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      expect(resolveCompletionProfilePath("bash")).toBe(path.join(homeDir, ".bash_profile"));
    });
  });

  it("recognizes cached Bash completion installed into the login profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profilePath = path.join(homeDir, ".bash_profile");
      await expect(fs.readFile(profilePath, "utf-8")).resolves.toContain(cachePath);
      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
      await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(false);

      const shell = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'source "$1"; complete -p openclaw',
          "openclaw",
          profilePath,
        ],
        { encoding: "utf8" },
      );
      expect(shell.stderr).toBe("");
      expect(shell.status).toBe(0);
      expect(shell.stdout).toContain("complete -W 'status' openclaw");
    });
  });

  it("detects slow dynamic Bash completion in the login profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      await fs.writeFile(
        path.join(homeDir, ".bash_profile"),
        "source <(openclaw completion --shell bash)\n",
        "utf-8",
      );

      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
      await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(true);
    });
  });

  it("prefers an existing .bashrc over the Bash login profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const bashrc = path.join(homeDir, ".bashrc");
      const bashProfile = path.join(homeDir, ".bash_profile");
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.writeFile(bashrc, "# existing interactive Bash profile\n", "utf-8");
      await fs.writeFile(bashProfile, "# existing Bash login profile\n", "utf-8");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");

      expect(resolveCompletionProfilePath("bash")).toBe(bashrc);
      await installCompletion("bash", true, "openclaw");

      await expect(fs.readFile(bashrc, "utf-8")).resolves.toContain(cachePath);
      await expect(fs.readFile(bashProfile, "utf-8")).resolves.toBe(
        "# existing Bash login profile\n",
      );
      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
      await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(false);
    });
  });

  it("formats PowerShell reload commands with single-quoted paths", () => {
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
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-bob's-"));

    try {
      await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
        const cachePath = resolveCompletionCachePath("powershell", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "# powershell completion\n", "utf-8");

        await installCompletion("powershell", true, "openclaw");

        const profilePath = resolveCompletionProfilePath("powershell");
        const profile = await fs.readFile(profilePath, "utf-8");
        expect(profile).toBe(`# OpenClaw Completion\n. '${cachePath.replace(/'/g, "''")}'\n`);
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects install when the completion cache is missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));

    try {
      await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
          "Completion cache not found",
        );
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
