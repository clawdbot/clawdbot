// Completion runtime tests cover shell completion generation and runtime file writes.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  COMPLETION_SHELLS,
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "./completion-runtime.js";

type PublishOutputFileAtomically =
  typeof import("./output-file.runtime.js").publishOutputFileAtomically;

const outputFileMocks = vi.hoisted(() => ({
  publishOutputFileAtomically: vi.fn<PublishOutputFileAtomically>(),
}));

vi.mock("./output-file.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
    "./output-file.runtime.js",
  );
  outputFileMocks.publishOutputFileAtomically.mockImplementation(
    actual.publishOutputFileAtomically,
  );
  return {
    ...actual,
    publishOutputFileAtomically: outputFileMocks.publishOutputFileAtomically,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withBashCompletionHome(
  run: (paths: { homeDir: string; stateDir: string }) => Promise<void>,
  stateDirPrefix = "openclaw-bash-completion-state-",
): Promise<void> {
  const homeDir = tempDirs.make("openclaw-bash-completion-home-");
  const stateDir = tempDirs.make(stateDirPrefix);

  await withEnvAsync(
    {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: undefined,
      ZDOTDIR: undefined,
    },
    async () => {
      await run({ homeDir, stateDir });
    },
  );
}

function expectAvailableShellToSucceed(
  shellName: "bash" | "zsh",
  result: SpawnSyncReturns<string>,
): void {
  if (result.error) {
    if (
      shellName === "zsh" &&
      "code" in result.error &&
      (result.error.code === "ENOENT" || result.error.code === "EACCES")
    ) {
      return;
    }
    throw result.error;
  }
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("completion-runtime", () => {
  it.each([
    {
      shell: "zsh" as const,
      variable: "ZDOTDIR",
      profileName: ".zshrc",
    },
    {
      shell: "fish" as const,
      variable: "XDG_CONFIG_HOME",
      profileName: path.join("fish", "config.fish"),
    },
  ])("installs $shell completion into its configured shell startup directory", async (testCase) => {
    const homeDir = tempDirs.make("openclaw-shell-profile-home-");
    const stateDir = tempDirs.make("openclaw-shell-profile-state-");
    const configDir = tempDirs.make(`openclaw-${testCase.shell} profile config-`);

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        ZDOTDIR: testCase.variable === "ZDOTDIR" ? configDir : undefined,
        XDG_CONFIG_HOME: testCase.variable === "XDG_CONFIG_HOME" ? configDir : undefined,
      },
      async () => {
        const cachePath = resolveCompletionCachePath(testCase.shell, "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "OPENCLAW_COMPLETION_LOADED=ready\n", "utf-8");

        await installCompletion(testCase.shell, true, "openclaw");

        const profilePath = path.join(configDir, testCase.profileName);
        expect(resolveCompletionProfilePath(testCase.shell)).toBe(profilePath);
        await expect(fs.readFile(profilePath, "utf-8")).resolves.toContain(cachePath);
        await expect(isCompletionInstalled(testCase.shell, "openclaw")).resolves.toBe(true);

        if (testCase.shell === "zsh") {
          const shell = spawnSync("zsh", ["-ic", '[[ "$OPENCLAW_COMPLETION_LOADED" = ready ]]'], {
            encoding: "utf8",
            env: process.env,
          });
          expectAvailableShellToSucceed("zsh", shell);
        }
      },
    );
  });

  it("preserves zsh's set-but-empty startup directory contract", () => {
    expect(
      resolveCompletionProfilePath("zsh", {
        env: { HOME: "/tmp/openclaw-home", ZDOTDIR: "" },
        homeDir: () => "/tmp/openclaw-home",
      }),
    ).toBe(path.join(path.sep, ".zshrc"));
  });

  it.skipIf(process.platform === "win32")(
    "preserves Zsh and Fish symlink traversal before parent path components",
    async () => {
      for (const testCase of [
        { shell: "zsh" as const, variable: "ZDOTDIR", profileName: ".zshrc" },
        {
          shell: "fish" as const,
          variable: "XDG_CONFIG_HOME",
          profileName: path.join("fish", "config.fish"),
        },
      ]) {
        await withBashCompletionHome(async ({ homeDir }) => {
          const profileParent = tempDirs.make(`openclaw-${testCase.shell}-symlink-profiles-`);
          const nestedProfiles = path.join(profileParent, "nested");
          const linkedProfiles = path.join(homeDir, "linked-profiles");
          await fs.mkdir(nestedProfiles, { recursive: true });
          await fs.symlink(nestedProfiles, linkedProfiles, "dir");

          await withEnvAsync(
            { [testCase.variable]: `${linkedProfiles}${path.sep}..` },
            async () => {
              const cachePath = resolveCompletionCachePath(testCase.shell, "openclaw");
              await fs.mkdir(path.dirname(cachePath), { recursive: true });
              await fs.writeFile(cachePath, "OPENCLAW_COMPLETION_LOADED=ready\n", "utf8");

              await installCompletion(testCase.shell, true, "openclaw");

              const profilePath = path.join(profileParent, testCase.profileName);
              await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);
              expect(resolveCompletionProfileHint(testCase.shell)).toBe(
                `~${path.sep}linked-profiles${path.sep}..${path.sep}${testCase.profileName}`,
              );
            },
          );
        });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves every shell's default profile traversal through a symlinked HOME",
    async () => {
      const fixtureRoot = tempDirs.make("openclaw-completion-home-symlink-");
      const realHome = path.join(fixtureRoot, "real-home");
      const nestedHome = path.join(realHome, "nested");
      const linkedHome = path.join(fixtureRoot, "linked-home");
      await fs.mkdir(nestedHome, { recursive: true });
      await fs.symlink(nestedHome, linkedHome, "dir");

      for (const testCase of [
        { shell: "zsh" as const, profileName: ".zshrc" },
        { shell: "bash" as const, profileName: ".bash_profile" },
        { shell: "fish" as const, profileName: path.join(".config", "fish", "config.fish") },
        {
          shell: "powershell" as const,
          profileName: path.join(".config", "powershell", "Microsoft.PowerShell_profile.ps1"),
        },
      ]) {
        const stateDir = tempDirs.make(`openclaw-${testCase.shell}-home-symlink-state-`);
        await withEnvAsync(
          {
            HOME: `${linkedHome}${path.sep}..`,
            USERPROFILE: `${linkedHome}${path.sep}..`,
            OPENCLAW_STATE_DIR: stateDir,
            XDG_CONFIG_HOME: undefined,
            ZDOTDIR: undefined,
          },
          async () => {
            const cachePath = resolveCompletionCachePath(testCase.shell, "openclaw");
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.writeFile(cachePath, `# cached ${testCase.shell} completion\n`, "utf8");

            await installCompletion(testCase.shell, true, "openclaw");

            const actualStartupProfile = path.join(realHome, testCase.profileName);
            await expect(fs.readFile(actualStartupProfile, "utf8")).resolves.toContain(cachePath);
            expect(resolveCompletionProfileHint(testCase.shell)).toBe(
              testCase.shell === "powershell"
                ? `${linkedHome}${path.sep}..${path.sep}${testCase.profileName}`
                : `~/${testCase.profileName}`,
            );
          },
        );
      }
    },
  );

  it.each(["relative-xdg", "~/relative-xdg"])(
    "ignores invalid relative Fish XDG configuration roots: %s",
    (configHome) => {
      const homeDir = path.join(path.sep, "tmp", "openclaw-home");
      expect(
        resolveCompletionProfilePath("fish", {
          env: { HOME: homeDir, XDG_CONFIG_HOME: configHome },
          homeDir: () => homeDir,
        }),
      ).toBe(path.join(homeDir, ".config", "fish", "config.fish"));
    },
  );

  it("preserves significant trailing whitespace in an absolute Fish XDG directory", () => {
    const homeDir = path.join(path.sep, "tmp", "openclaw-home");
    const configHome = path.join(path.sep, "tmp", "Fish Config ");
    expect(
      resolveCompletionProfilePath("fish", {
        env: { HOME: homeDir, XDG_CONFIG_HOME: configHome },
        homeDir: () => homeDir,
      }),
    ).toBe(path.join(configHome, "fish", "config.fish"));
  });

  it.each([
    {
      configHome: "C:\\Users\\Ada\\Fish Config",
      expected: "C:\\Users\\Ada\\Fish Config\\fish\\config.fish",
    },
    {
      configHome: "relative-fish",
      expected: "C:\\Users\\Ada\\.config\\fish\\config.fish",
    },
    {
      configHome: "\\\\fileserver\\profiles\\Fish Config",
      expected: "\\\\fileserver\\profiles\\Fish Config\\fish\\config.fish",
    },
  ])("resolves Windows Fish profiles with Windows separators: $configHome", (testCase) => {
    const homeDir = "C:\\Users\\Ada";
    expect(
      resolveCompletionProfilePath("fish", {
        env: { HOME: homeDir, XDG_CONFIG_HOME: testCase.configHome },
        homeDir: () => homeDir,
        platform: "win32",
      }),
    ).toBe(testCase.expected);
  });

  it.each(["~/literal startup", "~root/startup", "-startup", "../startup"])(
    "keeps relative Zsh profile hints literal: %s",
    async (profileRoot) => {
      await withEnvAsync({ HOME: "/tmp/openclaw-home", ZDOTDIR: profileRoot }, async () => {
        const profilePath = path.join(profileRoot, ".zshrc");
        const expected = profilePath.startsWith(`..${path.sep}`)
          ? profilePath
          : `.${path.sep}${profilePath}`;
        expect(resolveCompletionProfileHint("zsh")).toBe(expected);
      });
    },
  );

  it("resolves the documented Bash login profile when .bashrc is absent", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      expect(resolveCompletionProfilePath("bash")).toBe(path.join(homeDir, ".bash_profile"));
    });
  });

  it.each(["ordinary", "literal$dollar", "Ada's !42"])(
    "loads cached Bash completion from a %s path through the login profile",
    async (stateName) => {
      await withBashCompletionHome(async ({ homeDir }) => {
        const cachePath = resolveCompletionCachePath("bash", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");

        await installCompletion("bash", true, "openclaw");

        const profilePath = path.join(homeDir, ".bash_profile");
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
      }, `openclaw-completion-${stateName}-`);
    },
  );

  it("prints the same canonical reload hint used by Doctor and onboarding", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("zsh", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# completion\n", "utf8");
      await fs.writeFile(path.join(homeDir, ".zshrc"), "", "utf8");
      await fs.chmod(path.join(homeDir, ".zshrc"), 0o640);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await installCompletion("zsh", false, "openclaw");
        expect(log).toHaveBeenCalledWith(
          "Completion installed. Restart your shell or run: source ~/.zshrc",
        );
        if (process.platform !== "win32") {
          expect((await fs.stat(path.join(homeDir, ".zshrc"))).mode & 0o777).toBe(0o640);
        }
      } finally {
        log.mockRestore();
      }
    });
  });

  it("preserves an existing profile when atomic publication fails", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("zsh", "openclaw");
      const profilePath = path.join(homeDir, ".zshrc");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# completion\n", "utf8");
      await fs.writeFile(profilePath, "export IMPORTANT=keep\n", "utf8");
      await fs.chmod(profilePath, 0o640);
      const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
        "./output-file.runtime.js",
      );
      outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
        return await actual.publishOutputFileAtomically({
          ...params,
          writeTemp: async (tempPath) => {
            await params.writeTemp(tempPath);
            await fs.truncate(tempPath, 1);
            throw new Error("injected completion profile write failure");
          },
        });
      });

      await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
        "Failed to install completion: injected completion profile write failure",
      );

      await expect(fs.readFile(profilePath, "utf8")).resolves.toBe("export IMPORTANT=keep\n");
      if (process.platform !== "win32") {
        expect((await fs.stat(profilePath)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(homeDir)).toEqual([".zshrc"]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves a symlinked profile while replacing its target atomically",
    async () => {
      await withBashCompletionHome(async ({ homeDir }) => {
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        const targetDir = tempDirs.make("openclaw-completion-profile-target-");
        const targetPath = path.join(targetDir, "zshrc");
        const profilePath = path.join(homeDir, ".zshrc");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "# completion\n", "utf8");
        await fs.writeFile(targetPath, "export IMPORTANT=keep\n", "utf8");
        await fs.symlink(targetPath, profilePath);

        await installCompletion("zsh", true, "openclaw");

        expect((await fs.lstat(profilePath)).isSymbolicLink()).toBe(true);
        await expect(fs.readFile(targetPath, "utf8")).resolves.toContain("export IMPORTANT=keep\n");
        await expect(fs.readFile(targetPath, "utf8")).resolves.toContain(cachePath);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a dangling relative profile symlink while creating its target",
    async () => {
      await withBashCompletionHome(async ({ homeDir }) => {
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        const managedDir = path.join(homeDir, "managed");
        const targetPath = path.join(managedDir, "zshrc");
        const profilePath = path.join(homeDir, ".zshrc");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.mkdir(managedDir, { recursive: true });
        await fs.writeFile(cachePath, "# completion\n", "utf8");
        await fs.symlink(path.join("managed", "zshrc"), profilePath);

        await installCompletion("zsh", true, "openclaw");

        expect((await fs.lstat(profilePath)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(profilePath)).toBe(path.join("managed", "zshrc"));
        await expect(fs.readFile(targetPath, "utf8")).resolves.toContain("# OpenClaw Completion");
      });
    },
  );

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

  it("does not mistake an orphaned completion marker for an installed profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(
        path.join(homeDir, ".bash_profile"),
        "# OpenClaw Completion\nexport IMPORTANT=keep\n",
        "utf-8",
      );

      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(false);
    });
  });

  it("recognizes an installed profile when its completion cache has been removed", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.writeFile(
        path.join(homeDir, ".bash_profile"),
        `# OpenClaw Completion\n[ -f "${cachePath}" ] && source "${cachePath}"\n`,
        "utf-8",
      );

      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
    });
  });

  it.each(
    COMPLETION_SHELLS.flatMap((shell) => [
      { shell, generation: "legacy" },
      { shell, generation: "current" },
    ]),
  )(
    "replaces the $generation $shell source after the literal state directory changes",
    async ({ shell, generation }) => {
      await withBashCompletionHome(async () => {
        const previousStateDir = tempDirs.make(
          `openclaw-completion-previous-${process.platform === "win32" ? "" : '"'}$state's-`,
        );
        const profilePath = resolveCompletionProfilePath(shell);
        await withEnvAsync({ OPENCLAW_STATE_DIR: previousStateDir }, async () => {
          const previousCachePath = resolveCompletionCachePath(shell, "openclaw");
          await fs.mkdir(path.dirname(previousCachePath), { recursive: true });
          await fs.writeFile(previousCachePath, "# previous completion\n", "utf-8");
          if (generation === "current") {
            await installCompletion(shell, true, "openclaw");
          } else {
            // Stable v2026.8.2 wrote POSIX/Fish paths in raw double quotes.
            const source =
              shell === "powershell"
                ? `. '${previousCachePath.replaceAll("'", "''")}'`
                : shell === "fish"
                  ? `test -f "${previousCachePath}"; and source "${previousCachePath}"`
                  : `[ -f "${previousCachePath}" ] && source "${previousCachePath}"`;
            await fs.mkdir(path.dirname(profilePath), { recursive: true });
            await fs.writeFile(profilePath, `# OpenClaw Completion\n${source}\n`, "utf8");
          }
        });
        const previousSource = (await fs.readFile(profilePath, "utf8")).trim().split("\n").at(-1)!;

        const currentCachePath = resolveCompletionCachePath(shell, "openclaw");
        await fs.mkdir(path.dirname(currentCachePath), { recursive: true });
        await fs.writeFile(currentCachePath, "# current completion\n", "utf-8");
        await installCompletion(shell, true, "openclaw");

        const profile = await fs.readFile(profilePath, "utf-8");
        expect(profile).not.toContain(previousSource);
        expect(profile.match(/^# OpenClaw Completion$/gm)).toHaveLength(1);
        await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(true);
        await installCompletion(shell, true, "openclaw");
        await expect(fs.readFile(profilePath, "utf8")).resolves.toBe(profile);
      }, "openclaw-completion-current-$state's-");
    },
  );

  it("preserves unrelated generated-looking sources that are not owned by its profile marker", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const unrelatedSource = 'source "/opt/tools/completions/openclaw.zsh"';
      const unmarkedPriorSource = 'source "/opt/tools/completions/openclaw.bash"';
      const markedUserSources = [
        "source '/opt/tools/not-completions/openclaw.bash'",
        "source '/opt/tools/completions/openclaw.zsh'",
        "[ -f '/other/completions/openclaw.bash' ] && source '/opt/tools/completions/openclaw.bash'",
        '[ -f "/opt/tools/completions/openclaw.bash" ] && source "/opt/tools/completions/openclaw.bash"; export IMPORTANT=keep',
        "source '/opt/tools/completions/openclaw.bash'; export IMPORTANT=keep",
        'source "/old/completions/openclaw.bash"; printf "%s" "/other/completions/openclaw.bash"',
        "source '/opt/tools/completions/openclaw.bash",
        '. "/opt/tools/completions/openclaw.bash"',
      ];
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# current completion\n", "utf-8");
      await fs.writeFile(
        profilePath,
        [
          unrelatedSource,
          unmarkedPriorSource,
          ...markedUserSources.flatMap((source) => ["# OpenClaw Completion", source]),
          "",
        ].join("\n"),
        "utf-8",
      );

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      for (const source of [unrelatedSource, unmarkedPriorSource, ...markedUserSources]) {
        expect(profile).toContain(`${source}\n`);
      }
      expect(profile).toContain(cachePath);
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

  it("preserves unrelated profile lines while replacing orphaned completion blocks", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const refreshAlias = "alias refresh_openclaw='openclaw completion --write-state'";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(
        profilePath,
        `# OpenClaw Completion\nexport IMPORTANT=keep\n${refreshAlias}\n`,
        "utf-8",
      );

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain("export IMPORTANT=keep\n");
      expect(profile).toContain(`${refreshAlias}\n`);
      expect(profile.match(/^# OpenClaw Completion$/gm)).toHaveLength(1);
      expect(profile).toContain(cachePath);
    });
  });

  it("replaces documented dynamic completion without deleting unrelated aliases", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const refreshAlias = "alias refresh_openclaw='openclaw completion --write-state'";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(
        profilePath,
        `export IMPORTANT=keep\nsource <(openclaw completion --shell bash)\n${refreshAlias}\n`,
        "utf-8",
      );

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain("export IMPORTANT=keep\n");
      expect(profile).toContain(`${refreshAlias}\n`);
      expect(profile).not.toContain("source <(openclaw completion");
      expect(profile).toContain(cachePath);
    });
  });

  it.each([
    "export IMPORTANT=keep; source <(openclaw completion --shell bash)",
    "source <(openclaw completion --shell bash); export IMPORTANT=keep",
    'source <(openclaw completion --shell bash) >"$HOME/completion.log"',
    'eval "$(openclaw completion --shell bash)" >"$HOME/completion.log"',
    'source <(openclaw completion --shell bash >"$HOME/completion.log")',
  ])("preserves compound user-owned Bash profile statements: %s", async (compoundLine) => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(profilePath, `${compoundLine}\n`, "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain(`${compoundLine}\n`);
      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
    });
  });

  it.each([
    {
      name: "dot-sourced process substitution",
      sourceLine: ". <(openclaw completion --shell bash)",
    },
    {
      name: "eval command substitution",
      sourceLine: 'eval "$(openclaw completion --shell bash)"',
    },
  ])("replaces $name without deleting unrelated aliases", async ({ sourceLine }) => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const refreshAlias = "alias refresh_openclaw='openclaw completion --write-state'";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(profilePath, `${sourceLine}\n${refreshAlias}\n`, "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).not.toContain(sourceLine);
      expect(profile).toContain(`${refreshAlias}\n`);
      expect(profile).toContain(cachePath);
    });
  });

  it("replaces PowerShell dynamic pipelines without deleting unrelated command strings", async () => {
    await withBashCompletionHome(async () => {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      const profilePath = resolveCompletionProfilePath("powershell");
      const dynamicLine = "openclaw completion --shell powershell | Out-String | Invoke-Expression";
      const refreshCommand = '$refresh = "openclaw completion --write-state"';
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# PowerShell completion\n", "utf-8");
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, `${dynamicLine}\n${refreshCommand}\n`, "utf-8");

      await expect(usesSlowDynamicCompletion("powershell", "openclaw")).resolves.toBe(true);
      await installCompletion("powershell", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).not.toContain(dynamicLine);
      expect(profile).toContain(`${refreshCommand}\n`);
      expect(profile).toContain(cachePath);
    });
  });

  it.each([
    "openclaw completion --shell powershell | Out-String | Invoke-Expression; $env:IMPORTANT = 'keep'",
    'openclaw completion --shell powershell | Tee-Object "$HOME/generated.ps1" | Out-String | Invoke-Expression',
  ])("preserves compound user-owned PowerShell profile statements: %s", async (compoundLine) => {
    await withBashCompletionHome(async () => {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      const profilePath = resolveCompletionProfilePath("powershell");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# PowerShell completion\n", "utf-8");
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, `${compoundLine}\n`, "utf-8");

      await installCompletion("powershell", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain(`${compoundLine}\n`);
      expect(profile).toContain(`. '${cachePath}'`);
    });
  });

  it("formats PowerShell reload commands with single-quoted paths", () => {
    expect(formatCompletionReloadCommand("powershell", "C:\\Users\\Ada\\profile.ps1")).toBe(
      ". 'C:\\Users\\Ada\\profile.ps1'",
    );
  });

  it.each(["bash", "zsh"] as const)(
    "reloads a %s profile when its absolute path contains spaces",
    async (shellName) => {
      const profileDir = tempDirs.make(`openclaw ${shellName} Ada's !42 reload profile-`);
      const profilePath = path.join(profileDir, ".shellrc");
      await fs.writeFile(profilePath, "OPENCLAW_COMPLETION_LOADED=ready\n", "utf-8");

      const reloadCommand = formatCompletionReloadCommand(shellName, profilePath);
      expect(reloadCommand).toBe(`source '${profilePath.replaceAll("'", "'\\''")}'`);
      const shell = spawnSync(
        shellName,
        ["-c", `${reloadCommand}; [ "$OPENCLAW_COMPLETION_LOADED" = ready ]`],
        {
          encoding: "utf8",
        },
      );
      expectAvailableShellToSucceed(shellName, shell);
    },
  );

  it("quotes Fish reload profile paths containing spaces", () => {
    expect(formatCompletionReloadCommand("fish", "/tmp/Ada's !42 Lovelace/config.fish")).toBe(
      "source '/tmp/Ada\\'s !42 Lovelace/config.fish'",
    );
  });

  it.each(["bash", "zsh"] as const)(
    "preserves tilde expansion while quoting %s profile paths",
    (shellName) => {
      expect(formatCompletionReloadCommand(shellName, "~/Ada's !42 profile/.shellrc")).toBe(
        "source ~/'Ada'\\''s !42 profile/.shellrc'",
      );
    },
  );

  it.each([
    {
      name: "native Windows without SHELL",
      env: {},
      platform: "win32" as const,
      expected: "powershell",
    },
    {
      name: "native Windows with an unknown SHELL",
      env: { SHELL: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32" as const,
      expected: "powershell",
    },
    {
      name: "PowerShell Core from a Windows path",
      env: { SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
      platform: "win32" as const,
      expected: "powershell",
    },
    {
      name: "Windows PowerShell from a Windows path",
      env: { SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
      platform: "win32" as const,
      expected: "powershell",
    },
    {
      name: "recognized Bash on Windows",
      env: { SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" },
      platform: "win32" as const,
      expected: "bash",
    },
    {
      name: "non-Windows without SHELL",
      env: {},
      platform: "linux" as const,
      expected: "zsh",
    },
  ])("detects $name", ({ env, platform, expected }) => {
    expect(resolveShellFromEnv(env, platform)).toBe(expected);
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
    await withBashCompletionHome(async () => {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# powershell completion\n", "utf-8");

      await installCompletion("powershell", true, "openclaw");

      const profilePath = resolveCompletionProfilePath("powershell");
      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toBe(`# OpenClaw Completion\n. '${cachePath.replace(/'/g, "''")}'\n`);
    }, "openclaw-completion-state-bob's-");
  });

  it("rejects install when the completion cache is missing", async () => {
    await withBashCompletionHome(async () => {
      await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
        "Completion cache not found",
      );
    });
  });
});
