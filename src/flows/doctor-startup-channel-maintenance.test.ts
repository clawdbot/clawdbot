import { describe, expect, it } from "vitest";
import { maybeRunDoctorStartupChannelMaintenance } from "./doctor-startup-channel-maintenance.js";

describe("doctor startup channel maintenance", () => {
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
    const calls: unknown[] = [];
    const runtime = { log() {}, error() {} };

    await maybeRunDoctorStartupChannelMaintenance({
      cfg,
      env: { OPENCLAW_TEST: "1" },
      runChannelPluginStartupMaintenance: async (input) => {
        calls.push(input);
      },
      runtime,
      shouldRepair: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
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
    const calls: unknown[] = [];

    await maybeRunDoctorStartupChannelMaintenance({
      cfg: { channels: { matrix: {} } },
      runChannelPluginStartupMaintenance: async (input) => {
        calls.push(input);
      },
      runtime: { log() {}, error() {} },
      shouldRepair: false,
    });

    expect(calls).toEqual([]);
  });
});
