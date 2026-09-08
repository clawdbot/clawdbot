// Doctor completion tests cover final doctor status summaries and completion messaging.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
  formatCompletionReloadCommand,
  resolveCompletionCachePath,
} from "../cli/completion-runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  checkShellCompletionStatus,
  doctorShellCompletion,
  ensureCompletionCacheExists,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
  type ShellCompletionStatus,
} from "./doctor-completion.js";

const originalEnv = captureEnv([
  "HOME",
  "OPENCLAW_STATE_DIR",
  "SHELL",
  "XDG_CONFIG_HOME",
  "ZDOTDIR",
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  originalEnv.restore();
  vi.restoreAllMocks();
});

function status(overrides: Partial<ShellCompletionStatus> = {}): ShellCompletionStatus {
  return {
    shell: "zsh",
    profileInstalled: true,
    cacheExists: true,
    cachePath: "/tmp/openclaw.zsh",
    usesSlowPattern: false,
    ...overrides,
  };
}

describe("shell completion health mapping", () => {
  it("recognizes cached Bash completion from the documented login profile", async () => {
    const homeDir = tempDirs.make("openclaw-bash-profile-home-");
    const stateDir = tempDirs.make("openclaw-bash-profile-state-");
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/bash");

    const cachePath = path.join(stateDir, "completions", "openclaw.bash");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
    await fs.writeFile(
      path.join(homeDir, ".bash_profile"),
      `# OpenClaw Completion\n[ -f "${cachePath}" ] && source "${cachePath}"\n`,
      "utf-8",
    );

    await expect(checkShellCompletionStatus("openclaw", { shell: "bash" })).resolves.toEqual({
      shell: "bash",
      profileInstalled: true,
      cacheExists: true,
      cachePath,
      usesSlowPattern: false,
    });
  });

  it("reports slow dynamic Bash completion from the documented login profile", async () => {
    const homeDir = tempDirs.make("openclaw-bash-slow-profile-home-");
    const stateDir = tempDirs.make("openclaw-bash-slow-profile-state-");
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/bash");

    await fs.writeFile(
      path.join(homeDir, ".bash_profile"),
      "source <(openclaw completion --shell bash)\n",
      "utf-8",
    );

    await expect(checkShellCompletionStatus("openclaw", { shell: "bash" })).resolves.toEqual({
      shell: "bash",
      profileInstalled: true,
      cacheExists: false,
      cachePath: path.join(stateDir, "completions", "openclaw.bash"),
      usesSlowPattern: true,
    });
  });

  it("reports an orphaned shell-completion marker as uninstalled", async () => {
    const homeDir = tempDirs.make("openclaw-bash-orphaned-profile-home-");
    const stateDir = tempDirs.make("openclaw-bash-orphaned-profile-state-");
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/bash");

    const cachePath = path.join(stateDir, "completions", "openclaw.bash");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
    await fs.writeFile(
      path.join(homeDir, ".bash_profile"),
      "# OpenClaw Completion\nexport IMPORTANT=keep\n",
      "utf-8",
    );

    await expect(checkShellCompletionStatus("openclaw", { shell: "bash" })).resolves.toEqual({
      shell: "bash",
      profileInstalled: false,
      cacheExists: true,
      cachePath,
      usesSlowPattern: false,
    });
  });

  it("checks an explicit shell instead of the detected environment shell", async () => {
    const homeDir = tempDirs.make("openclaw-completion-home-");
    const stateDir = tempDirs.make("openclaw-completion-state-");
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/zsh");

    const current = await checkShellCompletionStatus("openclaw", { shell: "fish" });

    expect(current.shell).toBe("fish");
    expect(current.cachePath).toBe(path.join(stateDir, "completions", "openclaw.fish"));
    expect(current.profileInstalled).toBe(false);
    expect(current.cacheExists).toBe(false);
  });

  it("reports slow dynamic shell completion with dry-run effects", () => {
    const current = status({ usesSlowPattern: true, cacheExists: false });

    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/shell-completion",
        severity: "info",
        path: "shellCompletion.zsh",
      }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([
      {
        kind: "state",
        action: "would-generate-completion-cache",
        target: "/tmp/openclaw.zsh",
        dryRunSafe: true,
      },
      {
        kind: "file",
        action: "would-upgrade-shell-profile-completion",
        target: "zsh",
        dryRunSafe: false,
      },
    ]);
  });

  it("reports missing completion cache with a dry-run cache effect", () => {
    const current = status({ profileInstalled: true, cacheExists: false });

    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({
        severity: "info",
        message: expect.stringContaining("cache is missing"),
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([
      {
        kind: "state",
        action: "would-regenerate-completion-cache",
        target: "/tmp/openclaw.zsh",
        dryRunSafe: true,
      },
    ]);
  });

  it("keeps healthy shell completion quiet", () => {
    const current = status();

    expect(shellCompletionStatusToHealthFindings(current)).toEqual([]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([]);
  });
});

const installCompletionMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("../cli/completion-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/completion-runtime.js")>();
  return {
    ...actual,
    installCompletion: installCompletionMock,
  };
});

function mockPrompter(confirmValue = true) {
  return {
    confirm: vi.fn(async () => confirmValue),
    confirmAutoFix: vi.fn(async () => confirmValue),
    confirmAggressiveAutoFix: vi.fn(async () => confirmValue),
    confirmRuntimeRepair: vi.fn(async () => confirmValue),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: {
      shouldRepair: true,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  } as never;
}

async function setupDoctorCompletionTest(usesSlowPattern: boolean) {
  const homeDir = tempDirs.make("openclaw-doctor-home-");
  const stateDir = tempDirs.make("openclaw-doctor-state-");
  setTestEnvValue("HOME", homeDir);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("SHELL", "/bin/bash");

  const profilePath = path.join(homeDir, usesSlowPattern ? ".bashrc" : ".bash_profile");
  if (usesSlowPattern) {
    await fs.writeFile(
      profilePath,
      '# test bashrc\n[ -f "/tmp/nonexistent" ] && source <(openclaw completion bash)\n',
      "utf-8",
    );
    const cacheDir = path.join(stateDir, "completions");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "openclaw.bash"), "# completion cache\n", "utf-8");
  }
  return profilePath;
}

function wrappedFsError(code: string, profilePath: string): Error {
  const cause = Object.assign(new Error(`${code}: profile write failed`), {
    code,
    path: profilePath,
  });
  return new Error(`Failed to install completion: ${cause.message}`, { cause });
}

describe("doctorShellCompletion", () => {
  beforeEach(() => {
    installCompletionMock.mockReset();
    spawnSyncMock.mockClear();
  });

  it("shows the Bash login profile after installing completion without .bashrc", async () => {
    await setupDoctorCompletionTest(false);
    installCompletionMock.mockResolvedValue(undefined);
    const noteSpy = vi.spyOn(noteModule, "note");

    await doctorShellCompletion(mockPrompter());

    expect(installCompletionMock).toHaveBeenCalledWith("bash", true, "openclaw");
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("source ~/.bash_profile"),
      "Shell completion",
    );
  });

  it.each([
    { shell: "zsh", variable: "ZDOTDIR", profile: ".zshrc" },
    {
      shell: "fish",
      variable: "XDG_CONFIG_HOME",
      profile: path.join("fish", "config.fish"),
    },
  ])("reports the configured $shell startup profile after installation", async (testCase) => {
    const homeDir = tempDirs.make("openclaw-doctor-custom-profile-home-");
    const stateDir = tempDirs.make("openclaw-doctor-custom-profile-state-");
    const configDir = tempDirs.make(`openclaw doctor ${testCase.shell} profile-`);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", `/bin/${testCase.shell}`);
    setTestEnvValue(testCase.variable, configDir);
    installCompletionMock.mockResolvedValue(undefined);
    const noteSpy = vi.spyOn(noteModule, "note");

    await doctorShellCompletion(mockPrompter());

    expect(installCompletionMock).toHaveBeenCalledWith(testCase.shell, true, "openclaw");
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining(`source '${path.join(configDir, testCase.profile)}'`),
      "Shell completion",
    );
  });

  it.each([
    { generationMode: "core-only" as const, expectedSkipValue: "1" },
    { generationMode: "full" as const, expectedSkipValue: undefined },
  ])(
    "uses explicit $generationMode cache generation even with an ambient skip guard",
    async ({ generationMode, expectedSkipValue }) => {
      const stateDir = tempDirs.make("openclaw-doctor-state-");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue(COMPLETION_SKIP_PLUGIN_COMMANDS_ENV, "1");

      await expect(
        ensureCompletionCacheExists("openclaw", {
          shell: "powershell",
          generationMode,
        }),
      ).resolves.toBe(true);

      expect(spawnSyncMock).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(["completion", "--write-state", "--shell", "powershell"]),
        expect.any(Object),
      );
      const spawnCalls = spawnSyncMock.mock.calls as unknown as Array<
        [string, string[], { env?: NodeJS.ProcessEnv }]
      >;
      const spawnOptions = spawnCalls.at(-1)?.[2];
      expect(spawnOptions?.env?.[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]).toBe(expectedSkipValue);
    },
  );

  it.each([
    { code: "EACCES", usesSlowPattern: true, action: "upgraded" },
    { code: "EPERM", usesSlowPattern: true, action: "upgraded" },
    { code: "EROFS", usesSlowPattern: true, action: "upgraded" },
    { code: "EACCES", usesSlowPattern: false, action: "installed" },
    { code: "EPERM", usesSlowPattern: false, action: "installed" },
    { code: "EROFS", usesSlowPattern: false, action: "installed" },
  ])("offers session recovery when completion is not $action after $code", async (testCase) => {
    const profilePath = await setupDoctorCompletionTest(testCase.usesSlowPattern);
    const failedPath = path.dirname(profilePath);
    installCompletionMock.mockRejectedValue(wrappedFsError(testCase.code, failedPath));
    const noteSpy = vi.spyOn(noteModule, "note");

    await expect(doctorShellCompletion(mockPrompter())).resolves.not.toThrow();

    const command = formatCompletionReloadCommand(
      "bash",
      resolveCompletionCachePath("bash", "openclaw"),
    );
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining(command), "Shell completion");
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("session only"),
      "Shell completion",
    );
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining(failedPath), "Shell completion");
  });

  it("re-throws non-permission errors from installCompletion", async () => {
    const profilePath = await setupDoctorCompletionTest(true);
    installCompletionMock.mockRejectedValue(wrappedFsError("ENOSPC", profilePath));

    await expect(doctorShellCompletion(mockPrompter())).rejects.toThrow("ENOSPC");
  });
});
