// Session send policy tests cover message send eligibility decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "./send-policy.js";

describe("resolveSendPolicy", () => {
  const cfgWithRules = (
    rules: NonNullable<NonNullable<OpenClawConfig["session"]>["sendPolicy"]>["rules"],
  ) =>
    ({
      session: {
        sendPolicy: {
          default: "allow",
          rules,
        },
      },
    }) as OpenClawConfig;

  it("defaults to allow", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveSendPolicy({ cfg })).toBe("allow");
  });

  it("entry override wins", () => {
    const cfg = {
      session: { sendPolicy: { default: "allow" } },
    } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    expect(resolveSendPolicy({ cfg, entry })).toBe("deny");
  });

  it.each([
    {
      name: "rule match by channel + chatType",
      cfg: cfgWithRules([
        { action: "deny", match: { channel: "demo-channel", chatType: "group" } },
      ]),
      entry: {
        sessionId: "s",
        updatedAt: 0,
        channel: "demo-channel",
        chatType: "group",
      } as SessionEntry,
      sessionKey: "demo-channel:group:dev",
      expected: "deny",
    },
    {
      name: "rule match by keyPrefix",
      cfg: cfgWithRules([{ action: "deny", match: { keyPrefix: "cron:" } }]),
      sessionKey: "cron:job-1",
      expected: "deny",
    },
    {
      name: "rule match by rawKeyPrefix",
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      sessionKey: "agent:main:demo-channel:group:dev",
      expected: "deny",
    },
    {
      name: "rawKeyPrefix does not match other channels",
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      sessionKey: "agent:main:other-channel:group:dev",
      expected: "allow",
    },
    {
      name: "channel-scoped deny fires for direct session key without explicit channel field",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: "demo-channel:direct:user-1",
      expected: "deny",
    },
    {
      name: "channel-scoped deny fires for per-account-channel-peer DM key without explicit channel field",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: buildAgentPeerSessionKey({
        agentId: "main",
        channel: "demo-channel",
        accountId: "acct-1",
        peerKind: "direct",
        peerId: "user-1",
        dmScope: "per-account-channel-peer",
      }),
      expected: "deny",
    },
    {
      name: "chat-type deny fires for a per-peer DM key without session metadata",
      cfg: cfgWithRules([{ action: "deny", match: { chatType: "direct" } }]),
      sessionKey: buildAgentPeerSessionKey({
        agentId: "main",
        channel: "demo-channel",
        peerKind: "direct",
        peerId: "user-1",
        dmScope: "per-peer",
      }),
      expected: "deny",
    },
    {
      name: "channel deny accepts opaque Matrix peers with empty tail segments",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "matrix" } }]),
      sessionKey: "agent:main:matrix:channel:!room:[2001:db8::1]",
      expected: "deny",
    },
    {
      name: "chat-type deny applies to legacy channel keys",
      cfg: cfgWithRules([{ action: "deny", match: { chatType: "channel" } }]),
      sessionKey: "agent:main:channel:legacy-room",
      expected: "deny",
    },
    {
      name: "chat-type deny applies to colon-bearing legacy channel keys",
      cfg: cfgWithRules([{ action: "deny", match: { chatType: "channel" } }]),
      sessionKey: "agent:main:channel:!room:example.org",
      expected: "deny",
    },
    {
      name: "legacy channel keys overlapping canonical direct peers fail closed",
      cfg: cfgWithRules([{ action: "deny", match: { chatType: "channel" } }]),
      sessionKey: "agent:main:channel:direct:user",
      expected: "deny",
    },
    {
      name: "ambiguous account and peer-kind tokens fail closed",
      cfg: cfgWithRules([{ action: "deny", match: { chatType: "direct" } }]),
      sessionKey: "agent:main:telegram:group:direct:user",
      expected: "deny",
    },
    {
      name: "bare direct and channel-shaped tokens fail closed",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "direct" } }]),
      sessionKey: "agent:main:direct:group:room",
      expected: "deny",
    },
    {
      name: "bare dm and account-shaped tokens fail closed",
      cfg: cfgWithRules([{ action: "deny", match: { chatType: "group" } }]),
      sessionKey: "agent:main:dm:account:group:room",
      expected: "deny",
    },
    {
      name: "channel-scoped deny ignores later peer-kind-looking tokens in non-channel keys",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: "demo-channel:not-a-peer-kind:user-1:direct",
      expected: "allow",
    },
    {
      name: "channel-scoped deny ignores incomplete account-scoped keys",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: "demo-channel:acct-1:direct",
      expected: "allow",
    },
  ])("$name", ({ cfg, entry, sessionKey, expected }) => {
    expect(resolveSendPolicy({ cfg, entry, sessionKey })).toBe(expected);
  });

  it("does not apply channel allow rules to nested opaque identities", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "deny",
          rules: [
            { action: "allow", match: { channel: "matrix" } },
            { action: "allow", match: { chatType: "channel" } },
          ],
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSendPolicy({
        cfg,
        sessionKey: "agent:voice:agent:other:matrix:channel:!room:example.org",
      }),
    ).toBe("deny");
    expect(
      resolveSendPolicy({
        cfg,
        sessionKey: "agent:voice:agent:voice::matrix:channel:!roomabc:example.org",
      }),
    ).toBe("deny");
  });

  it.each([
    "agent:main:direct",
    "agent:main:demo:acct:channel",
    "agent:main:demo::channel:room",
    "agent::demo:direct:user",
  ])("does not apply peer allow rules to malformed key %s", (sessionKey) => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "deny",
          rules: [
            { action: "allow", match: { channel: "demo" } },
            { action: "allow", match: { chatType: "direct" } },
            { action: "allow", match: { chatType: "channel" } },
          ],
        },
      },
    } as OpenClawConfig;

    expect(resolveSendPolicy({ cfg, sessionKey })).toBe("deny");
  });
});
