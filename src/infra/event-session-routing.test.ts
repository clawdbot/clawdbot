// Covers event session routing policy resolution.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  parseDirectAgentSessionTarget,
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  resolveMainScopedEventSessionKey,
  scopedHeartbeatWakeOptionsForPolicy,
} from "./event-session-routing.js";

describe("event session routing", () => {
  it("parses per-peer, per-channel, and per-account direct session keys", () => {
    expect(parseDirectAgentSessionTarget("agent:main:direct:123")).toEqual({
      agentId: "main",
      peerId: "123",
    });
    expect(parseDirectAgentSessionTarget("agent:main:telegram:direct:123")).toEqual({
      agentId: "main",
      channel: "telegram",
      peerId: "123",
    });
    expect(parseDirectAgentSessionTarget("agent:main:telegram:work:direct:123")).toEqual({
      agentId: "main",
      channel: "telegram",
      accountId: "work",
      peerId: "123",
    });
    expect(
      parseDirectAgentSessionTarget("agent:main:telegram:work:direct:123:thread:1712345678.123"),
    ).toEqual({
      agentId: "main",
      channel: "telegram",
      accountId: "work",
      peerId: "123",
    });
  });

  it("routes single-owner dmScope=main direct event keys to the agent main session", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      channels: {
        telegram: {
          accounts: {
            work: { allowFrom: ["123"] },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveEventSessionRoutingPolicy({
      cfg,
      sessionKey: "agent:main:telegram:work:direct:123",
    });

    expect(resolveEventSessionKeyForPolicy("agent:main:telegram:work:direct:123", policy)).toBe(
      "agent:main:main",
    );
    expect(
      scopedHeartbeatWakeOptionsForPolicy(
        "agent:main:telegram:work:direct:123",
        { reason: "exec-event" },
        policy,
      ),
    ).toEqual({ reason: "exec-event", sessionKey: "agent:main:main" });
    expect(
      resolveEventSessionKeyForPolicy(
        "agent:main:telegram:work:direct:123:thread:1712345678.123",
        policy,
      ),
    ).toBe("agent:main:main");
  });

  it("does not route multi-owner or wildcard direct sessions to main", () => {
    const baseCfg: OpenClawConfig = {
      session: { dmScope: "main" },
      channels: {
        telegram: { allowFrom: ["123", "456"] },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveMainScopedEventSessionKey({
        cfg: baseCfg,
        sessionKey: "agent:main:telegram:default:direct:123",
      }),
    ).toBeNull();
    expect(
      resolveMainScopedEventSessionKey({
        cfg: {
          ...baseCfg,
          channels: { telegram: { allowFrom: ["*"] } },
        } as unknown as OpenClawConfig,
        sessionKey: "agent:main:telegram:default:direct:123",
      }),
    ).toBeNull();
  });

  it("preserves route-binding direct session overrides under global dmScope=main", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      channels: {
        telegram: {
          accounts: {
            work: { allowFrom: ["123"] },
          },
        },
      },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "telegram",
            accountId: "work",
            peer: { kind: "direct", id: "123" },
          },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    } as unknown as OpenClawConfig;
    const sessionKey = "agent:main:telegram:work:direct:123";
    const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
    const threadSessionKey = `${sessionKey}:thread:1712345678.123`;
    const threadPolicy = resolveEventSessionRoutingPolicy({ cfg, sessionKey: threadSessionKey });

    expect(policy.preserveSessionKey).toBe(true);
    expect(resolveEventSessionKeyForPolicy(sessionKey, policy)).toBe(sessionKey);
    expect(threadPolicy.preserveSessionKey).toBe(true);
    expect(resolveEventSessionKeyForPolicy(threadSessionKey, threadPolicy)).toBe(threadSessionKey);
  });

  it("keeps cron-run remapping behavior unchanged", () => {
    const policy = { mainKey: "primary", sessionScope: "per-sender" as const };

    expect(resolveEventSessionKeyForPolicy("agent:ops:cron:nightly:run:abc", policy)).toBe(
      "agent:ops:primary",
    );
    expect(
      scopedHeartbeatWakeOptionsForPolicy(
        "agent:ops:cron:nightly:run:abc",
        { reason: "exec-event" },
        policy,
      ),
    ).toEqual({ reason: "exec-event", sessionKey: "agent:ops:primary" });
  });
});
