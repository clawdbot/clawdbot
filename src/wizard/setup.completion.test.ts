// Setup completion tests cover final onboarding instructions and paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  formatCompletionReloadCommand,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
} from "../cli/completion-runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setupWizardShellCompletion } from "./setup.completion.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withLocale(locale: string, run: () => Promise<void>): Promise<void> {
  const previousLocale = process.env.OPENCLAW_LOCALE;
  process.env.OPENCLAW_LOCALE = locale;
  try {
    await run();
  } finally {
    if (previousLocale === undefined) {
      delete process.env.OPENCLAW_LOCALE;
    } else {
      process.env.OPENCLAW_LOCALE = previousLocale;
    }
  }
}

function createPrompter(confirmValue = false) {
  return {
    confirm: vi.fn(async () => confirmValue),
    note: vi.fn(async () => {}),
  };
}

function createDeps(shell: "zsh" | "bash" | "fish" | "powershell" = "zsh") {
  const deps: NonNullable<Parameters<typeof setupWizardShellCompletion>[0]["deps"]> = {
    resolveCliName: () => "openclaw",
    checkShellCompletionStatus: vi.fn(async (_binName: string) => ({
      shell,
      profileInstalled: false,
      cacheExists: false,
      cachePath: `/tmp/openclaw.${shell === "powershell" ? "ps1" : shell}`,
      usesSlowPattern: false,
    })),
    ensureCompletionCacheExists: vi.fn(async (_binName: string) => true),
    installCompletion: vi.fn(async () => {}),
  };
  return deps;
}

function wrappedFsError(code: string, profilePath: string): Error {
  const cause = Object.assign(new Error(`${code}: profile write failed`), {
    code,
    path: profilePath,
  });
  return new Error(`Failed to install completion: ${cause.message}`, { cause });
}

describe("setupWizardShellCompletion", () => {
  it("QuickStart: installs without prompting", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupWizardShellCompletion({ flow: "quickstart", prompter, deps });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("openclaw", {
      generationMode: "full",
    });
    expect(deps.installCompletion).toHaveBeenCalledWith("zsh", true, "openclaw");
    expect(prompter.note).toHaveBeenCalled();
  });

  it("Advanced: prompts; skip means no install", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupWizardShellCompletion({ flow: "advanced", prompter, deps });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(deps.ensureCompletionCacheExists).not.toHaveBeenCalled();
    expect(deps.installCompletion).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });

  describe.each(["en", "zh-CN", "zh-TW"])("%s permission recovery", (locale) => {
    it.each([
      {
        description: "upgrading a slow shell profile",
        profileInstalled: true,
        usesSlowPattern: true,
      },
      {
        description: "installing a new shell profile",
        profileInstalled: false,
        usesSlowPattern: false,
      },
    ])(
      "offers session recovery when $description fails",
      async ({ profileInstalled, usesSlowPattern }) => {
        await withLocale(locale, async () => {
          const failedPath = "/tmp/read-only/.openclaw-completion-profile-stage";
          const prompter = createPrompter();
          const deps = createDeps();
          vi.mocked(deps.checkShellCompletionStatus!).mockResolvedValue({
            shell: "zsh",
            profileInstalled,
            cacheExists: false,
            cachePath: "/tmp/openclaw.zsh",
            usesSlowPattern,
          });
          vi.mocked(deps.installCompletion!).mockRejectedValue(
            wrappedFsError("EACCES", failedPath),
          );

          await expect(
            setupWizardShellCompletion({ flow: "quickstart", prompter, deps }),
          ).resolves.not.toThrow();

          expect(prompter.note).toHaveBeenCalledTimes(1);
          expect(prompter.note).toHaveBeenCalledWith(
            expect.stringContaining("source /tmp/openclaw.zsh"),
            "Shell completion",
          );
          expect(prompter.note).toHaveBeenCalledWith(
            expect.stringContaining(failedPath),
            "Shell completion",
          );
        });
      },
    );
  });

  it("re-throws unexpected completion installation errors", async () => {
    const prompter = createPrompter();
    const deps = createDeps();
    vi.mocked(deps.installCompletion!).mockRejectedValue(
      wrappedFsError("ENOSPC", "/tmp/full/.zshrc"),
    );

    await expect(
      setupWizardShellCompletion({ flow: "quickstart", prompter, deps }),
    ).rejects.toThrow("ENOSPC");
  });

  it.each([
    {
      description: "upgrading a slow shell profile",
      profileInstalled: true,
      usesSlowPattern: true,
    },
    {
      description: "repairing a missing completion cache",
      profileInstalled: true,
      usesSlowPattern: false,
    },
    {
      description: "installing a new completion profile",
      profileInstalled: false,
      usesSlowPattern: false,
    },
  ])(
    "reports cache generation failure when $description",
    async ({ profileInstalled, usesSlowPattern }) => {
      const prompter = createPrompter();
      const deps = createDeps();
      vi.mocked(deps.checkShellCompletionStatus!).mockResolvedValue({
        shell: "zsh",
        profileInstalled,
        cacheExists: false,
        cachePath: "/tmp/openclaw.zsh",
        usesSlowPattern,
      });
      vi.mocked(deps.ensureCompletionCacheExists!).mockResolvedValue(false);

      await setupWizardShellCompletion({ flow: "quickstart", prompter, deps });

      expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("openclaw", {
        generationMode: "full",
      });
      expect(prompter.note).toHaveBeenCalledWith(
        "Failed to generate completion cache. Run `openclaw completion --write-state --install` later.",
        "Shell completion",
      );
      expect(deps.installCompletion).not.toHaveBeenCalled();
      expect(prompter.note.mock.calls.flat().join("\n")).not.toContain("source /tmp/openclaw.zsh");
    },
  );

  it("localizes advanced prompts and install notes", async () => {
    await withLocale("zh-CN", async () => {
      const prompter = createPrompter(true);
      const deps = createDeps();

      await setupWizardShellCompletion({ flow: "advanced", prompter, deps });

      expect(prompter.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "为 openclaw 启用 zsh shell completion？",
        }),
      );
      expect(prompter.note).toHaveBeenCalledWith(
        "Shell completion 已安装。重启 shell 或运行：source ~/.zshrc",
        "Shell completion",
      );
    });
  });

  it.each([
    { shell: "zsh" as const, variable: "ZDOTDIR", profileName: ".zshrc" },
    {
      shell: "fish" as const,
      variable: "XDG_CONFIG_HOME",
      profileName: path.join("fish", "config.fish"),
    },
  ])("installs and reports the actual configured $shell startup profile", async (testCase) => {
    const homeDir = tempDirs.make("openclaw-wizard-completion-home-");
    const stateDir = tempDirs.make("openclaw-wizard-completion-state-");
    const profileRoot = tempDirs.make(`openclaw wizard ${testCase.shell} Ada's !42 profile-`);

    await withEnvAsync(
      {
        HOME: homeDir,
        USERPROFILE: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        SHELL: `/bin/${testCase.shell}`,
        ZDOTDIR: undefined,
        XDG_CONFIG_HOME: undefined,
        [testCase.variable]: profileRoot,
      },
      async () => {
        const cachePath = resolveCompletionCachePath(testCase.shell, "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "OPENCLAW_COMPLETION_LOADED=ready\n", "utf8");
        const prompter = createPrompter();

        await setupWizardShellCompletion({
          flow: "quickstart",
          prompter,
          deps: { ensureCompletionCacheExists: async () => true },
        });

        const profilePath = path.join(profileRoot, testCase.profileName);
        expect(resolveCompletionProfilePath(testCase.shell)).toBe(profilePath);
        await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);
        expect(prompter.note).toHaveBeenCalledWith(
          `Shell completion installed. Restart your shell or run: ${formatCompletionReloadCommand(testCase.shell, profilePath)}`,
          "Shell completion",
        );
      },
    );
  });

  it("resolves the concrete Windows PowerShell profile path", () => {
    expect(
      resolveCompletionProfilePath("powershell", {
        env: { USERPROFILE: "C:\\Users\\Ada" },
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
  });

  it("shows a concrete PowerShell profile reload command after setup", async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = "/Users/ada";
    try {
      const prompter = createPrompter();
      const deps = createDeps("powershell");

      await setupWizardShellCompletion({ flow: "quickstart", prompter, deps });

      expect(deps.installCompletion).toHaveBeenCalledWith("powershell", true, "openclaw");
      expect(prompter.note).toHaveBeenCalledWith(
        "Shell completion installed. Restart your shell or run: . '/Users/ada/.config/powershell/Microsoft.PowerShell_profile.ps1'",
        "Shell completion",
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});
