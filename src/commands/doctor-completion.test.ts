// Doctor completion tests cover final doctor status summaries and completion messaging.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../cli/completion-runtime.js";
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
  ])("keeps $action completion best-effort for wrapped $code errors", async (testCase) => {
    const profilePath = await setupDoctorCompletionTest(testCase.usesSlowPattern);
    installCompletionMock.mockRejectedValue(wrappedFsError(testCase.code, profilePath));
    const noteSpy = vi.spyOn(noteModule, "note");

    await expect(doctorShellCompletion({} as never, mockPrompter())).resolves.not.toThrow();

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `Shell completion not ${testCase.action}: .* is not writable.*completion --install`,
        ),
      ),
      "Shell completion",
    );
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining(profilePath), "Shell completion");
  });

  it("re-throws non-permission errors from installCompletion", async () => {
    const profilePath = await setupDoctorCompletionTest(true);
    installCompletionMock.mockRejectedValue(wrappedFsError("ENOSPC", profilePath));

    await expect(doctorShellCompletion({} as never, mockPrompter())).rejects.toThrow("ENOSPC");
  });
});
