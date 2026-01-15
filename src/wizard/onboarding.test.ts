import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import type { RuntimeEnv } from "../runtime.js";
import { runOnboardingWizard } from "./onboarding.js";
import type { WizardPrompter } from "./prompts.js";

const setupChannels = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const setupSkills = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const writeConfigFile = vi.hoisted(() => vi.fn(async () => {}));
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({ exists: false, valid: true, config: {} })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const ensureControlUiAssetsBuilt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const runTui = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../commands/onboard-channels.js", () => ({
  setupChannels,
}));

vi.mock("../commands/onboard-skills.js", () => ({
  setupSkills,
}));

vi.mock("../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    ensureWorkspaceAndSessions,
    detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
    openUrl: vi.fn(async () => true),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(async () => ({ ok: true })),
    resolveControlUiLinks: vi.fn(() => ({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    })),
  };
});

vi.mock("../commands/systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt,
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

describe("runOnboardingWizard", () => {
  it("exits when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.clawdbot/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
      legacyIssues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });

    const select: WizardPrompter["select"] = vi.fn(async () => "quickstart");
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(
      runOnboardingWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("exit:1");

    expect(select).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalled();
  });

  it("skips prompts and setup steps when flags are set", async () => {
    const select: WizardPrompter["select"] = vi.fn(async () => "quickstart");
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(select).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });

  it("launches TUI without auto-delivery when hatching", async () => {
    runTui.mockClear();

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-onboard-"));
    await fs.writeFile(path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME), "{}");

    const confirm: WizardPrompter["confirm"] = vi.fn(async (opts) => {
      if (opts.message === "Do you want to hatch your bot now?") return true;
      return opts.initialValue ?? false;
    });

    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "quickstart"),
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => ""),
      confirm,
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        mode: "local",
        workspace: workspaceDir,
        authChoice: "skip",
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
      },
      runtime,
      prompter,
    );

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: false,
        message: "Wake up, my friend!",
      }),
    );

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("shows the web search hint at the end of onboarding", async () => {
    const prevBraveKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    try {
      const note: WizardPrompter["note"] = vi.fn(async () => {});
      const prompter: WizardPrompter = {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note,
        select: vi.fn(async () => "quickstart"),
        multiselect: vi.fn(async () => []),
        text: vi.fn(async () => ""),
        confirm: vi.fn(async () => false),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      };

      const runtime: RuntimeEnv = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await runOnboardingWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );

      const calls = (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall?.[1]).toBe("Web search (optional)");
    } finally {
      if (prevBraveKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = prevBraveKey;
      }
    }
  });
});
