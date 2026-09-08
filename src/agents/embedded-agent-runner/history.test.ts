// Coverage for resolving channel and DM history limits from session keys.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import type { AgentMessage } from "../runtime/index.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";

describe("getHistoryLimitFromSessionKey", () => {
  it("does not match channel history limits across provider id variants", () => {
    // Channel ids and provider ids are not normalized across spelling variants;
    // guessing here could apply the wrong retention policy.
    expect(
      getHistoryLimitFromSessionKey("agent:main:z-ai:channel:general", {
        channels: {
          "z.ai": {
            historyLimit: 17,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when sessionKey or config is undefined", () => {
    expect(getHistoryLimitFromSessionKey(undefined, {})).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", undefined)).toBeUndefined();
  });

  it("returns dmHistoryLimit for direct message sessions", () => {
    const config = {
      channels: {
        telegram: { dmHistoryLimit: 15 },
        whatsapp: { dmHistoryLimit: 20 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
    expect(getHistoryLimitFromSessionKey("whatsapp:dm:123", config)).toBe(20);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123", config)).toBe(15);
  });

  it("keeps backward compatibility for dm and direct session kinds", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10 } },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("telegram:direct:123", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:123", config)).toBe(10);
  });

  it("strips numeric thread and topic suffixes from direct message session keys", () => {
    // Numeric thread/topic suffixes are routing detail, not part of the DM id
    // used for per-contact history limit overrides.
    const config = {
      channels: { telegram: { dmHistoryLimit: 10, dms: { "123": { historyLimit: 7 } } } },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123:thread:999", config)).toBe(7);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:123:topic:555", config)).toBe(7);
    expect(getHistoryLimitFromSessionKey("telegram:dm:123:thread:999", config)).toBe(7);
  });

  it("resolves account-scoped direct session keys", () => {
    // session.dmScope "per-account-channel-peer" builds
    // agent:<agent>:<channel>:<account>:direct:<peer>, so the account segment sits
    // where the kind normally does.
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          accounts: { work: { dmHistoryLimit: 11, dms: { "123": { historyLimit: 22 } } } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:work:direct:456", config)).toBe(11);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:work:direct:123", config)).toBe(22);
    // A key without the account segment still resolves the root value.
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:456", config)).toBe(4);
  });

  it("uses observed peer identity rather than the account name to resolve ambiguous keys", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          dms: { "direct:peer": { historyLimit: 31 } },
          accounts: { direct: { dmHistoryLimit: 12, dms: { peer: { historyLimit: 41 } } } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:direct:peer", config, {
        accountId: "direct",
        peerId: "peer",
      }),
    ).toBe(41);
    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:direct:peer", config, {
        accountId: "direct",
      }),
    ).toBe(12);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:direct:peer", config)).toBe(4);
  });

  it("does not read a root peer id beginning with direct as an account segment", () => {
    // A root key whose peer id starts with "direct:" has the same segment shape as
    // the account form, so inferring account scope from segment 2 alone would look
    // up dms["peer"] and silently ignore the configured dms["direct:peer"].
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          dms: { "direct:peer": { historyLimit: 31 }, peer: { historyLimit: 32 } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:direct:peer", config, {
        peerId: "direct:peer",
      }),
    ).toBe(31);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:dm:peer", config)).toBe(4);
  });

  it("preserves a linked DM peer when its first segment matches the routed account", () => {
    const config = {
      session: {
        dmScope: "per-channel-peer",
        identityLinks: { "direct:peer": ["telegram:123"] },
      },
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          accounts: {
            direct: {
              dmHistoryLimit: 12,
              dms: { "direct:peer": { historyLimit: 31 }, peer: { historyLimit: 41 } },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId: "direct",
      peerKind: "direct",
      peerId: "123",
      dmScope: config.session.dmScope,
      identityLinks: config.session.identityLinks,
    });

    expect(
      getHistoryLimitFromSessionKey(sessionKey, config, {
        accountId: "direct",
        peerId: "123",
        chatType: "direct",
      }),
    ).toBe(31);
  });

  it("lets an account dms map replace the root map instead of merging per entry", () => {
    // The account merge contract replaces the whole map, so a root peer that the
    // account map omits must fall through to the account default, not the root entry.
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          dms: { "123": { historyLimit: 99 }, "456": { historyLimit: 98 } },
          accounts: { work: { dmHistoryLimit: 11, dms: { "123": { historyLimit: 22 } } } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:123", config, {
        accountId: "work",
      }),
    ).toBe(22);
    // 456 exists only in the root map, so the account default wins over it.
    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:456", config, {
        accountId: "work",
      }),
    ).toBe(11);
    // With no account, the root map still applies.
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:456", config)).toBe(98);
  });

  it.each(["direct", "dm", "group", "channel"])(
    "resolves routed scope for an account named %s",
    (accountId) => {
      const config = {
        channels: {
          telegram: {
            historyLimit: 8,
            dmHistoryLimit: 4,
            accounts: {
              [accountId]: {
                historyLimit: 9,
                dmHistoryLimit: 12,
                dms: { peer: { historyLimit: 41 }, "direct:peer": { historyLimit: 31 } },
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      const route = { accountId, peerId: "peer", chatType: "direct" as const };
      const sessionKey = buildAgentPeerSessionKey({
        agentId: "main",
        channel: "telegram",
        accountId,
        peerKind: "direct",
        peerId: route.peerId,
        dmScope: "per-account-channel-peer",
      });
      expect(getHistoryLimitFromSessionKey(sessionKey, config, route)).toBe(41);
      expect(getHistoryLimitFromSessionKey(`${sessionKey}:thread:99`, config, route)).toBe(41);
      const sharedKey = buildAgentPeerSessionKey({
        agentId: "main",
        channel: "telegram",
        accountId,
        peerId: route.peerId,
        dmScope: "main",
      });
      expect(getHistoryLimitFromSessionKey(sharedKey, config, route)).toBeUndefined();
      const groupKey = buildAgentPeerSessionKey({
        agentId: "main",
        channel: "telegram",
        accountId,
        peerKind: "group",
        peerId: "direct:peer",
      });
      expect(getHistoryLimitFromSessionKey(groupKey, config, { ...route, chatType: "group" })).toBe(
        9,
      );
      expect(
        getHistoryLimitFromSessionKey(groupKey, config, {
          ...route,
          accountId: "other",
          chatType: "group",
        }),
      ).toBe(8);
    },
  );

  it("does not select another peer's override after identity-link changes or a dispatch override", () => {
    const config = {
      session: { identityLinks: { "direct:peer": ["telegram:123"] } },
      channels: {
        telegram: {
          accounts: {
            direct: {
              dmHistoryLimit: 12,
              dms: { peer: { historyLimit: 41 }, "direct:peer": { historyLimit: 31 } },
            },
            personal: { dmHistoryLimit: 19, dms: { "direct:peer": { historyLimit: 23 } } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const route = { accountId: "direct", peerId: "123", chatType: "direct" as const };
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId: route.accountId,
      peerId: route.peerId,
      dmScope: "per-channel-peer",
      identityLinks: config.session.identityLinks,
    });
    expect(getHistoryLimitFromSessionKey(sessionKey, config, route)).toBe(31);
    expect(
      getHistoryLimitFromSessionKey(
        sessionKey,
        { ...config, session: { identityLinks: { changed: ["telegram:123"] } } },
        route,
      ),
    ).toBe(12);
    expect(getHistoryLimitFromSessionKey(sessionKey, { ...config, session: {} }, route)).toBe(12);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:another", config, route)).toBe(
      12,
    );
    expect(getHistoryLimitFromSessionKey("agent:main:main", config, route)).toBeUndefined();
    const overrideKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId: "work",
      peerId: route.peerId,
      dmScope: "per-account-channel-peer",
      identityLinks: config.session.identityLinks,
    });
    expect(
      getHistoryLimitFromSessionKey(overrideKey, config, { ...route, accountId: "personal" }),
    ).toBe(23);
    expect(
      getHistoryLimitFromSessionKey(overrideKey, config, {
        ...route,
        accountId: "personal",
        peerId: "456",
      }),
    ).toBe(19);
  });

  it("keeps non-numeric thread markers in direct message ids", () => {
    const config = {
      channels: {
        telegram: { dms: { "user:thread:abc": { historyLimit: 9 } } },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:user:thread:abc", config)).toBe(9);
  });

  it.each(["a::b", "alice:thread:123", "alice:topic:123"])(
    "preserves linked peer %s and known accounts after peer changes",
    (linkedPeer) => {
      const config = {
        session: { identityLinks: { [linkedPeer]: ["telegram:123"] } },
        channels: {
          telegram: {
            dmHistoryLimit: 4,
            accounts: {
              work: {
                dmHistoryLimit: 12,
                dms: {
                  [linkedPeer]: { historyLimit: 31 },
                  "a:b": { historyLimit: 41 },
                  alice: { historyLimit: 42 },
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      const sessionKey = buildAgentPeerSessionKey({
        agentId: "main",
        channel: "telegram",
        accountId: "work",
        peerId: "123",
        dmScope: "per-account-channel-peer",
        identityLinks: config.session.identityLinks,
      });
      expect(getHistoryLimitFromSessionKey(sessionKey, config, { peerId: "123" })).toBe(31);
      expect(
        getHistoryLimitFromSessionKey(`${sessionKey}:thread:99`, config, { peerId: "123" }),
      ).toBe(31);
      expect(getHistoryLimitFromSessionKey(sessionKey, config, { peerId: "changed" })).toBe(12);
    },
  );

  it("uses per-DM overrides before provider defaults", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: {
            "123": { historyLimit: 5 },
            "456": {},
            "789": { historyLimit: 0 },
          },
        },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(5);
    expect(getHistoryLimitFromSessionKey("telegram:dm:456", config)).toBe(15);
    expect(getHistoryLimitFromSessionKey("telegram:dm:789", config)).toBe(0);
    expect(getHistoryLimitFromSessionKey("telegram:dm:other", config)).toBe(15);
  });

  it("returns per-DM overrides for agent-prefixed keys and colon-containing ids", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 20,
          dms: { "789": { historyLimit: 3 } },
        },
        msteams: {
          dmHistoryLimit: 10,
          dms: { "user@example.com": { historyLimit: 7 } },
        },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:789", config)).toBe(3);
    expect(getHistoryLimitFromSessionKey("msteams:dm:user@example.com", config)).toBe(7);
  });

  it("returns historyLimit for channel and group sessions", () => {
    const config = {
      channels: {
        slack: { historyLimit: 10, dmHistoryLimit: 15 },
        discord: { historyLimit: 8 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("agent:beta:slack:channel:c1", config)).toBe(10);
    expect(getHistoryLimitFromSessionKey("discord:channel:123456", config)).toBe(8);
    expect(getHistoryLimitFromSessionKey("discord:group:123", config)).toBe(8);
  });

  it("returns undefined for unsupported session kinds, unknown providers, and missing limits", () => {
    const config = {
      channels: {
        telegram: { historyLimit: 10 },
        discord: { dmHistoryLimit: 10 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:slash:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("unknown:dm:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("discord:channel:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBeUndefined();
  });

  it("handles supported provider ids for DM and channel history limits", () => {
    const providers = [
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "msteams",
      "nextcloud-talk",
    ] as const;

    for (const provider of providers) {
      const config = {
        channels: { [provider]: { dmHistoryLimit: 5, historyLimit: 12 } },
      } as OpenClawConfig;

      expect(getHistoryLimitFromSessionKey(`${provider}:dm:123`, config)).toBe(5);
      expect(getHistoryLimitFromSessionKey(`${provider}:channel:123`, config)).toBe(12);
      expect(getHistoryLimitFromSessionKey(`agent:main:${provider}:channel:456`, config)).toBe(12);
    }
  });

  it("prefers account-scoped limits over the channel root for that account", () => {
    const config = {
      channels: {
        telegram: {
          historyLimit: 10,
          dmHistoryLimit: 15,
          dms: { "123": { historyLimit: 7 } },
          accounts: {
            work: {
              historyLimit: 40,
              dmHistoryLimit: 41,
              dms: { "123": { historyLimit: 42 } },
            },
            sparse: { historyLimit: 50 },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const cases: Array<[string, string | undefined, number | undefined]> = [
      // Account values win for every scope the resolver supports.
      ["telegram:channel:c1", "work", 40],
      ["telegram:group:g1", "work", 40],
      ["telegram:dm:999", "work", 41],
      ["telegram:dm:123", "work", 42],
      // Without an account id, or for an account that omits the key, the root still applies.
      ["telegram:channel:c1", undefined, 10],
      ["telegram:dm:999", undefined, 15],
      ["telegram:dm:123", undefined, 7],
      ["telegram:dm:999", "sparse", 15],
      ["telegram:dm:123", "sparse", 7],
      ["telegram:channel:c1", "missing-account", 10],
    ];

    for (const [sessionKey, accountId, expected] of cases) {
      expect(
        getHistoryLimitFromSessionKey(sessionKey, config, { accountId }),
        `${sessionKey}/${accountId}`,
      ).toBe(expected);
    }
  });

  it("matches an operator-written account key against the canonical routed id", () => {
    // Routing canonicalizes account ids, so "Work Team" arrives as "work-team".
    // Exact-key config lookup would miss it and silently fall back to the root.
    const config = {
      channels: {
        telegram: {
          historyLimit: 10,
          dmHistoryLimit: 15,
          dms: { "123": { historyLimit: 7 } },
          accounts: {
            "Work Team": {
              historyLimit: 40,
              dmHistoryLimit: 41,
              dms: { "123": { historyLimit: 42 } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    for (const accountId of ["work-team", "Work Team", "WORK TEAM"]) {
      expect(getHistoryLimitFromSessionKey("telegram:channel:c1", config, { accountId })).toBe(40);
      expect(getHistoryLimitFromSessionKey("telegram:dm:999", config, { accountId })).toBe(41);
      expect(getHistoryLimitFromSessionKey("telegram:dm:123", config, { accountId })).toBe(42);
    }
    // An unrelated account still falls back to the root.
    expect(
      getHistoryLimitFromSessionKey("telegram:channel:c1", config, { accountId: "other" }),
    ).toBe(10);
  });

  it("treats an explicit account limit of 0 as a real override", () => {
    const config = {
      channels: {
        slack: {
          historyLimit: 25,
          dmHistoryLimit: 30,
          accounts: { off: { historyLimit: 0, dmHistoryLimit: 0 } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("slack:channel:c1", config, { accountId: "off" })).toBe(0);
    expect(getHistoryLimitFromSessionKey("slack:dm:u1", config, { accountId: "off" })).toBe(0);
  });
});

describe("account-scoped limits change the retained transcript", () => {
  // The resolver returning a different number is not the user-visible effect;
  // what matters is that the transcript actually keeps fewer turns. This drives
  // the real resolver and the real trimmer together, no mocks.
  function transcript(userTurns: number): AgentMessage[] {
    return Array.from(
      { length: userTurns * 2 },
      (_, i) =>
        (i % 2 === 0
          ? { role: "user", content: `q${i / 2}` }
          : { role: "assistant", content: `a${(i - 1) / 2}` }) as AgentMessage,
    );
  }

  function countUserTurns(messages: AgentMessage[]) {
    return messages.filter((message) => message.role === "user").length;
  }

  const cfg = {
    channels: {
      telegram: {
        historyLimit: 20,
        accounts: { "Work Team": { historyLimit: 2 } },
      },
    },
  } as unknown as OpenClawConfig;

  const sessionKey = "agent:main:telegram:channel:c1";
  const messages = transcript(40);

  it("trims to the account limit for that account", () => {
    const limited = limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(sessionKey, cfg, { accountId: "work-team" }),
    );
    // limit 2 with the documented 1.5x eviction cushion keeps far fewer turns
    // than the root limit of 20, and strictly fewer than the input.
    expect(countUserTurns(limited)).toBeLessThan(countUserTurns(messages));
    expect(countUserTurns(limited)).toBeLessThanOrEqual(3);
  });

  it("trims to the channel root when the account does not override", () => {
    const rootLimited = limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(sessionKey, cfg, { accountId: "other-account" }),
    );
    const accountLimited = limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(sessionKey, cfg, { accountId: "work-team" }),
    );
    expect(countUserTurns(rootLimited)).toBeGreaterThan(countUserTurns(accountLimited));
    expect(countUserTurns(rootLimited)).toBeLessThanOrEqual(30);
  });
});
