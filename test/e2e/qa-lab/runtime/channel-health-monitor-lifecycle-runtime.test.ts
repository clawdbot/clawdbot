import { describe, expect, it } from "vitest";
import { runChannelHealthMonitorLifecycleProof } from "./channel-health-monitor-lifecycle-runtime.js";

describe("channel health monitor lifecycle producer", () => {
  it("proves scheduler, policy, repair, logging, and shutdown boundaries", async () => {
    const proof = await runChannelHealthMonitorLifecycleProof();

    expect(proof).toMatchObject({
      graceRespected: true,
      policyReasons: ["startup-connect-grace", "stale-socket", "busy", "stuck"],
      singleFlight: true,
      settledRearmed: true,
      cooldownBounded: true,
      hourlyCapLogged: true,
      failureRecovered: true,
      shutdownStoppedChecks: true,
    });
    expect(proof.operationOrder.slice(0, 3)).toEqual([
      "stop:qa-channel:monitored:false",
      "reset:qa-channel:monitored",
      "start:qa-channel:monitored",
    ]);
    expect(proof.restartLog).toContain("restarting (reason: disconnected)");
  });
});
