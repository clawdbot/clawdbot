// Configure wizard persistence tests protect config writes before local side effects.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  writeWizardConfigFile: vi.fn(),
  probeGatewayReachable: vi.fn(),
  waitForGatewayReachable: vi.fn(),
  healthCommand: vi.fn(),
  maybeInstallDaemon: vi.fn(),
}));

vi.mock("./configure.shared.js", () => ({
  CONFIGURE_SECTION_OPTIONS: [
    { value: "daemon", label: "Daemon", hint: "Manage the background service" },
    { value: "health", label: "Health check", hint: "Run gateway checks" },
  ],
  confirm: vi.fn(),
  intro: mocks.intro,
  outro: mocks.outro,
  select: mocks.select,
  text: mocks.text,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  resolveGatewayPort: () => 18789,
}));

vi.mock("../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../wizard/clack-prompter.js", () => ({ createClackPrompter: () => ({}) }));
vi.mock("../wizard/setup.shared.js", () => ({
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));
vi.mock("../wizard/setup.secret-input.js", () => ({
  resolveSetupSecretInputString: vi.fn(async () => undefined),
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  guardCancel: (value: unknown) => value,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveAdvertisedControlUiLinks: vi.fn(async () => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  resolveLocalControlUiProbeLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  summarizeExistingConfig: vi.fn(() => "Gateway: remote"),
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("./onboard-agent-target.js", () => ({
  ensureOnboardingAgentWorkspace: vi.fn(),
  resolveOnboardingAgentTarget: () => ({
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
    workspaceDir: "/tmp/openclaw-workspace",
  }),
}));

vi.mock("../plugins/install-record-commit.js", () => ({
  commitConfigWithPendingPluginInstalls: vi.fn(),
}));
vi.mock("../plugins/plugin-registry.js", () => ({ resolvePluginContributionOwners: vi.fn() }));
vi.mock("./configure.channels.js", () => ({ removeChannelConfigWizard: vi.fn() }));
vi.mock("./configure.daemon.js", () => ({ maybeInstallDaemon: mocks.maybeInstallDaemon }));
vi.mock("./configure.gateway-auth.js", () => ({ promptAuthConfig: vi.fn() }));
vi.mock("./configure.gateway.js", () => ({ promptGatewayConfig: vi.fn() }));
vi.mock("./health.js", () => ({ healthCommandNonExiting: mocks.healthCommand }));
vi.mock("./onboard-channels.js", () => ({ setupChannels: vi.fn() }));
vi.mock("./onboard-remote.js", () => ({ promptRemoteGatewayConfig: vi.fn() }));
vi.mock("./onboard-skills.js", () => ({ setupSkills: vi.fn() }));

import { runConfigureWizard } from "./configure.wizard.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("configure wizard persistence before local side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        exists: true,
        valid: true,
        config: { gateway: { mode: "remote" } },
        issues: [],
      },
      writeOptions: {
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
      },
    });
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.waitForGatewayReachable.mockResolvedValue({ ok: false });
    mocks.text.mockResolvedValue("18789");
  });

  it.each([
    ["health", "succeeded"],
    ["daemon", "succeeded"],
    ["health", "failed"],
    ["daemon", "failed"],
  ] as const)("persists Local before %s reports %s", async (section, outcome) => {
    const choices = ["local", section, "__continue"];
    const events: string[] = [];
    const writes: OpenClawConfig[] = [];
    mocks.select.mockImplementation(async () => choices.shift());
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => {
      events.push("commit");
      writes.push(config);
      return config;
    });
    if (section === "health") {
      mocks.waitForGatewayReachable.mockImplementationOnce(async () => {
        events.push("health");
        return { ok: outcome === "succeeded" };
      });
    } else {
      mocks.maybeInstallDaemon.mockImplementationOnce(async () => {
        events.push("daemon");
        return outcome;
      });
    }

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.gateway?.mode).toBe("local");
    expect(events).toEqual(["commit", section]);
    if (outcome === "failed") {
      expect(mocks.outro).toHaveBeenLastCalledWith(
        `Configuration updated, but ${section === "health" ? "health check" : "daemon setup"} failed.`,
      );
      expect(mocks.outro).not.toHaveBeenCalledWith("Configuration updated.");
    }
  });
});
