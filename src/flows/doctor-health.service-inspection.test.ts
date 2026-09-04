// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const execFile = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/exec-file.js").execFileUtf8>(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    termination: "exit" as const,
  })),
);

// Inject the service-manager fault at the process boundary so the fixture covers
// the scope fallback and hint classification the operator actually hits.
vi.mock("../daemon/exec-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exec-file.js")>()),
  execFileUtf8: execFile,
}));

const { mocks } = await import("./doctor-health.test-support.js");

const USER_SCOPE_BUS_STDERR =
  "Failed to connect to user scope bus via local transport: No such file or directory";
const MACHINE_SCOPE_BUS_STDERR =
  "Failed to connect to system scope bus via machine transport: Permission denied\nCall failed: Transport endpoint is not connected";

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
  // A set bus address keeps systemd absence unproven, as on the reported host.
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
  execFile.mockImplementation(async (_command, args) => ({
    stdout: "",
    stderr: args[0] === "--machine" ? MACHINE_SCOPE_BUS_STDERR : USER_SCOPE_BUS_STDERR,
    code: 1,
    termination: "exit" as const,
  }));
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    const configBefore = fs.readFileSync(state.configPath);
    mocks.packageRoot.mockReturnValue(process.cwd());
    mocks.config.mockReturnValue(cfg);
    const stop = vi.fn();
    const daemon =
      await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const systemdService = daemon.resolveGatewayService();
    platform.mockRestore();
    mocks.service.mockReturnValue({ ...systemdService, stop });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const run = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
    await expect(run).rejects.toThrow("Doctor could not enter maintenance");
    await expect(run).rejects.toThrow("gateway status --deep");
    await expect(run).rejects.toThrow("dbus-user-session");
    await expect(run).rejects.toThrow("loginctl enable-linger");
    await expect(run).rejects.not.toThrow(
      /--no-restart|before the update|No such file|machine transport/,
    );
    expect(execFile).toHaveBeenCalledWith(
      "busctl",
      expect.arrayContaining(["--machine"]),
      expect.anything(),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(mocks.runContributions).not.toHaveBeenCalled();
    expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
  });
});
