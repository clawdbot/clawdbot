import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCompletionProfilePath } from "../cli/completion-runtime.js";
import { setupWizardShellCompletion } from "./setup.completion.js";

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

describe("setupWizardShellCompletion", () => {
  it("QuickStart: installs without prompting", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupWizardShellCompletion({ flow: "quickstart", prompter, deps });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("openclaw");
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
