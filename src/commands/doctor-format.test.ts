import { describe, expect, it } from "vitest";
import { buildGatewayRuntimeHints } from "./doctor-format.js";

describe("buildGatewayRuntimeHints", () => {
  it("surfaces suspicious systemd cgroup hygiene with inspection commands", () => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            unit: "openclaw-gateway.service",
            killMode: "process",
            tasksCurrent: 807,
            memoryCurrent: 11_918_534_246,
          },
        },
        { platform: "linux", env: {} },
      ),
    ).toEqual([
      "Systemd cgroup hygiene looks elevated: cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB.",
      "This usually means old helper or browser processes may still be attached to the gateway service.",
      "Run: systemctl --user show openclaw-gateway.service -p KillMode -p TasksCurrent -p MemoryCurrent -p MainPID",
      "Run: systemd-cgls --user-unit openclaw-gateway.service",
      "After reviewing service settings, run: openclaw gateway restart",
    ]);
  });

  it("does not warn for normal systemd cgroup metrics", () => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            unit: "openclaw-gateway.service",
            killMode: "control-group",
            tasksCurrent: 7,
            memoryCurrent: 132_120_576,
          },
        },
        { platform: "linux", env: {} },
      ),
    ).toEqual([]);
  });
});
