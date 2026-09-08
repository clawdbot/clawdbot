// Covers event session routing policy resolution.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  resolveMainScopedEventSessionKey,
  scopedHeartbeatWakeOptionsForPolicy,
} from "./event-session-routing.js";

describe("event session routing", () => {
  it.each([
    ["account DM", 0],
    ["nested account DM", 1],
    ["account", 2],
    ["nested account", 3],
    ["channel DM", 4],
    ["channel", 5],
  ] as const)(
    "uses the first configured %s allowlist, including an empty list",
    (_source, first) => {
      for (const selected of [["123"], []]) {
        const lists = Array.from({ length: 6 }, (_, index) =>
          index < first ? undefined : index === first ? selected : [`other-${index}`],
        );
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          channels: {
            example: {
              dm: { allowFrom: lists[4] },
              allowFrom: lists[5],
              accounts: {
                work: {
                  dm: { allowFrom: lists[0] },
                  allowFrom: lists[2],
                  config: { dm: { allowFrom: lists[1] }, allowFrom: lists[3] },
                },
              },
            },
          },
        };
        const sessionKey = "agent:main:example:work:direct:123:thread:456";
        const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
        expect(policy.allowFrom).toEqual(selected);
        expect(resolveEventSessionKeyForPolicy(sessionKey, policy)).toBe(
          selected.length === 0 ? sessionKey : "agent:main:main",
        );
      }
    },
  );

  it.each([
    { channel: undefined, accountId: undefined, expected: "original" },
    { channel: " Other ", accountId: " ALT ", expected: "override" },
    { channel: "", accountId: " ", expected: "original" },
    { channel: "other", accountId: "", expected: "other-work" },
  ])("resolves channel/account overrides $channel/$accountId", ({ expected, ...overrides }) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      channels: {
        example: { accounts: { work: { allowFrom: ["original"] } } },
        other: {
          accounts: {
            work: { allowFrom: ["other-work"] },
            alt: { allowFrom: ["override"] },
          },
        },
      },
    };
    const params = {
      cfg,
      sessionKey: "agent:main:example:work:direct:123",
      ...overrides,
    };
    expect(resolveEventSessionRoutingPolicy(params).allowFrom).toEqual([expected]);
    expect(resolveEventSessionRoutingPolicy({ ...params, allowFrom: [] }).allowFrom).toEqual([]);
  });

  it.each([
    ["agent:ops_1:example:direct:123", "agent:ops_1:main"],
    ["  AGENT:OPS_1:EXAMPLE:DIRECT:123:THREAD:t  ", "agent:ops_1:main"],
    ["agent:ops_1:example:direct:123:thread:", "agent:ops_1:main"],
    ["agent:ops_1:example:direct:123:thread:first:thread:last", null],
    ["agent::example:direct:123:thread:t", null],
    ["agent:ops_1::example:direct:123:thread:t", null],
    ["prefix:agent:ops_1:example:direct:123:thread:t", null],
    ["agent:ops_1:agent:other:example:direct:123:thread:t", null],
    ["agent:ops_1:example:direct::thread:t", null],
    ["agent:ops_1:example:group:123:thread:t", null],
  ] as const)("preserves direct event owner and thread parsing for %s", (sessionKey, expected) => {
    expect(
      resolveMainScopedEventSessionKey({
        cfg: {
          agents: { entries: { ops_1: {} } },
          channels: { example: { allowFrom: ["123"] } },
        },
        sessionKey,
      }),
    ).toBe(expected);
  });

  it("routes single-owner dmScope=main direct event keys to the agent main session", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
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
      agents: { entries: { main: { default: true } } },
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
      agents: { entries: { main: { default: true } } },
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
