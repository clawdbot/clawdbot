import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRunDoctorStartupChannelMaintenance } from "./doctor-startup-channel-maintenance.js";

const runChannelPluginStartupMaintenance = vi.hoisted(() => vi.fn());

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance,
}));

describe("doctor startup channel maintenance", () => {
  beforeEach(() => {
    runChannelPluginStartupMaintenance.mockClear();
  });

  it("runs Matrix startup migration during repair flows", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        },
      },
    };
    const runtime = { log: vi.fn(), error: vi.fn() };

    await maybeRunDoctorStartupChannelMaintenance({
      cfg,
      env: { OPENCLAW_TEST: "1" },
      runtime,
      shouldRepair: true,
    });

    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledTimes(1);
    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        env: { OPENCLAW_TEST: "1" },
        trigger: "doctor-fix",
        logPrefix: "doctor",
        log: expect.objectContaining({
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
  });

  it("skips startup migration outside repair flows", async () => {
    await maybeRunDoctorStartupChannelMaintenance({
      cfg: { channels: { matrix: {} } },
      runtime: { log: vi.fn(), error: vi.fn() },
      shouldRepair: false,
    });

    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
  });
});
