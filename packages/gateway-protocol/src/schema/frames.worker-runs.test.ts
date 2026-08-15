import { describe, expect, it } from "vitest";
import { validateConnectParams } from "../validator-registry.js";

describe("node worker-runs connect manifest", () => {
  const connect = {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
  };

  it("accepts only the exact additive worker build identity", () => {
    expect(
      validateConnectParams({
        ...connect,
        workerRuns: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.8.12",
          protocolFeatures: ["worker-heartbeat-v1"],
        },
      }),
    ).toBe(true);
    expect(validateConnectParams({ ...connect, workerRuns: { enabled: true } })).toBe(false);
  });
});
