// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

beforeEach(() => {
  mocks.service.mockReset();
  mocks.probePortUsage.mockReset().mockResolvedValue("free");
  mocks.emulateNativeInstall = true;
  mocks.outro.mockClear();
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  mocks.servicePlatform = undefined;
  vi.unstubAllEnvs();
});

it("names the systemd user-bus failure when repair cannot inspect the managed service", async () => {
  // Headless Linux without dbus-user-session: the unit is healthy, but the
  // strict busctl inspection fails and Doctor must say why, not just refuse.
  mocks.servicePlatform = "linux";
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
  vi.stubEnv("OPENCLAW_CONTAINER", undefined);
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    const configBefore = fs.readFileSync(state.configPath);
    mocks.packageRoot.mockReturnValue(process.cwd());
    mocks.config.mockReturnValue(cfg);
    const stop = vi.fn();
    mocks.service.mockReturnValue({
      readCommand: async () => {
        throw new Error(
          "Effective systemd service command could not be inspected: Failed to connect to user scope bus via local transport: No such file or directory",
        );
      },
      readRuntime: async () => ({ status: "running" }),
      isLoaded: async () => true,
      stop,
      restart: vi.fn(),
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const run = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
    await expect(run).rejects.toThrow("Doctor could not enter maintenance");
    await expect(run).rejects.toThrow("gateway status --deep");
    await expect(run).rejects.toThrow("dbus-user-session");
    await expect(run).rejects.toThrow("loginctl enable-linger");
    await expect(run).rejects.not.toThrow(/--no-restart|before the update|No such file/);
    expect(stop).not.toHaveBeenCalled();
    expect(mocks.runContributions).not.toHaveBeenCalled();
    expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
  });
});
