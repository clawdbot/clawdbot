import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isHeartbeatEnabledForSessionAgent } from "./subagents/spawn/acp-spawn-heartbeat.js";
import { resolveAcpSpawnRequesterState } from "./subagents/spawn/acp-spawn-requester.js";

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

  it("uses the prepared requester owner for a bare key in an ownerless fleet", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: {},
          research: { heartbeat: { every: "5m" } },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      isHeartbeatEnabledForSessionAgent({
        cfg,
        requesterAgentId: "research",
        sessionKey: "global",
      }),
    ).toBe(true);

    expect(
      resolveAcpSpawnRequesterState({
        cfg,
        parentSessionKey: "global",
        requesterAgentId: "research",
        targetAgentId: "ops",
        ctx: {},
      }).heartbeatEnabled,
    ).toBe(true);
  });
});
