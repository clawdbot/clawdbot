// Covers heartbeat config resolution shared by scheduling, wake handling, and doctor.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatForWake } from "./heartbeat-runner-config.js";

function cfgWithHeartbeat(overrides?: {
  timeoutSeconds?: number;
  lightContext?: boolean;
  target?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        heartbeat: {
          every: "30m",
          target: "owner",
          timeoutSeconds: 1800,
          lightContext: false,
          ...overrides,
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveHeartbeatForWake", () => {
  it("merges destination-only override with configured heartbeat for cron source", () => {
    const heartbeat = resolveHeartbeatForWake({
      cfg: cfgWithHeartbeat(),
      agentId: "main",
      requestedHeartbeat: { target: "last" },
      source: "cron",
    });
    expect(heartbeat).toMatchObject({
      timeoutSeconds: 1800,
      lightContext: false,
      target: "last",
    });
  });

  it("merges destination-only override with configured heartbeat for non-cron source", () => {
    const heartbeat = resolveHeartbeatForWake({
      cfg: cfgWithHeartbeat(),
      agentId: "main",
      requestedHeartbeat: { target: "last" },
      source: "manual",
    });
    expect(heartbeat).toMatchObject({
      timeoutSeconds: 1800,
      lightContext: false,
      target: "last",
    });
  });

  it("strips explicit destination fields for cron target=last", () => {
    const heartbeat = resolveHeartbeatForWake({
      cfg: cfgWithHeartbeat({ target: "whatsapp", timeoutSeconds: 600 }),
      agentId: "main",
      configuredHeartbeat: {
        every: "30m",
        target: "whatsapp",
        to: "+1555",
        accountId: "ops",
        timeoutSeconds: 600,
      },
      requestedHeartbeat: { target: "last" },
      source: "cron",
    });
    expect(heartbeat).toMatchObject({
      target: "last",
      timeoutSeconds: 600,
    });
    expect(heartbeat?.to).toBeUndefined();
    expect(heartbeat?.accountId).toBeUndefined();
  });

  it("preserves configured timeout when non-cron override only carries target", () => {
    const heartbeat = resolveHeartbeatForWake({
      cfg: cfgWithHeartbeat({ timeoutSeconds: 1800 }),
      agentId: "main",
      requestedHeartbeat: { target: "last" },
      source: "notifications-event",
    });
    expect(heartbeat?.timeoutSeconds).toBe(1800);
  });
});
