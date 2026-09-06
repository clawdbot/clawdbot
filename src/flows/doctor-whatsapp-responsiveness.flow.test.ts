import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
  ps: vi.fn(),
  checkGatewayHealth: vi.fn(),
  probeGatewayMemoryStatus: vi.fn(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("./doctor-gateway-exec-credential.js", () => ({
  hasActiveGatewayExecCredential: async () => false,
}));
vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));
vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(mocks.ps, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});
// Do not mock doctor-whatsapp-responsiveness: its actual owner reads mocked ps
// and builds the advisory note through the real contribution runner.

describe("Doctor responsiveness contribution flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])("keeps CPU advice observational (maintenance=%s)", async (maintenance) => {
    const cfg = { channels: { whatsapp: { enabled: true } } };
    const status = {
      eventLoop: {
        degraded: true,
        degradedSinceMs: 0,
        reasons: ["cpu"],
        intervalMs: 1_000,
        delayP99Ms: 40,
        delayMaxMs: 40,
        utilization: 0.04,
        cpuCoreRatio: 2,
      },
    };
    const fakePid = process.pid + 1_000_000;
    mocks.ps.mockReturnValue({
      status: 0,
      stdout: `${fakePid} openclaw-tui --profile unrelated\n`,
    });
    mocks.checkGatewayHealth.mockResolvedValue({ healthOk: true, authenticated: false, status });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: cfg,
      configResult: { cfg },
      env: {},
      options: { repair: maintenance, nonInteractive: true },
      gatewayMaintenanceActive: maintenance,
    });
    ctx.prompter = createDoctorPrompter({ runtime: ctx.runtime, options: ctx.options });
    expect(ctx.prompter.shouldRepair).toBe(maintenance);
    const selected = resolveDoctorHealthContributions().filter((entry) =>
      ["doctor:gateway-health", "doctor:whatsapp-responsiveness"].includes(entry.id),
    );
    expect(selected.map((entry) => entry.id)).toEqual([
      "doctor:gateway-health",
      "doctor:whatsapp-responsiveness",
    ]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("This advisory flow must not signal any process");
    });
    try {
      await runDoctorHealthContributionList(ctx, selected);
      expect(ctx.gatewayStatus).toEqual(maintenance ? undefined : status);
      expect(mocks.checkGatewayHealth).toHaveBeenCalledTimes(maintenance ? 0 : 1);
      expect(mocks.probeGatewayMemoryStatus).not.toHaveBeenCalled();
      const notes = mocks.note.mock.calls.filter(
        ([, title]) => title === "WhatsApp responsiveness",
      );
      if (maintenance || process.platform === "win32") {
        expect(mocks.ps).not.toHaveBeenCalled();
        expect(notes).toEqual([]);
      } else {
        expect(mocks.ps).toHaveBeenCalledTimes(1);
        expect(mocks.ps).toHaveBeenCalledWith("ps", ["-axo", "pid=,command="], {
          encoding: "utf8",
          killSignal: "SIGKILL",
          timeout: 1_000,
        });
        expect(notes).toEqual([
          [
            "Gateway reports pressure, and local TUI clients were detected. This snapshot does not identify the source of the pressure.\n" +
              `Local TUI pids: ${fakePid}\n` +
              "Inspect Gateway diagnostics with openclaw gateway diagnostics export before deciding whether to close clients.",
            "WhatsApp responsiveness",
          ],
        ]);
      }
      expect(kill).not.toHaveBeenCalled();
      expect(mocks.note.mock.calls.filter(([, title]) => title === "Doctor warnings")).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });
});
