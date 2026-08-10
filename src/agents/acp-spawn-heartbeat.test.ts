import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isHeartbeatEnabledForSessionAgent } from "./acp-spawn-heartbeat.js";

describe("isHeartbeatEnabledForSessionAgent", () => {
  it("uses the persisted fixed-store owner for a bare requester key", () => {
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "research" } },
        entries: {
          ops: {},
          research: { heartbeat: { every: "5m" } },
        },
      },
    } satisfies OpenClawConfig;

    expect(isHeartbeatEnabledForSessionAgent({ cfg, sessionKey: "global" })).toBe(true);
  });

  it("honors an explicit ambient heartbeat owner after resolving the requester", () => {
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: {
          sessionStore: { agentId: "research" },
          heartbeat: { agentId: "research", every: "5m" },
        },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(isHeartbeatEnabledForSessionAgent({ cfg, sessionKey: "global" })).toBe(true);
  });
});
