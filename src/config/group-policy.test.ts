import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveToolsBySender,
} from "./group-policy.js";

describe("resolveChannelGroupPolicy", () => {
  it("fails closed when groupPolicy=allowlist and groups are missing", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("allows configured groups when groupPolicy=allowlist", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "123@g.us": { requireMention: true },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("blocks all groups when groupPolicy=disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "disabled",
          groups: {
            "*": { requireMention: false },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowed).toBe(false);
  });

  it("respects account-scoped groupPolicy overrides", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      accountId: "work",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("allows groups when groupPolicy=allowlist with hasGroupAllowFrom but no groups", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
      hasGroupAllowFrom: true,
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("still fails closed when groupPolicy=allowlist without groups or groupAllowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
      hasGroupAllowFrom: false,
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("can default explicitly configured groups to no mention for channels that opt in", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {},
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveChannelGroupRequireMention({
        cfg,
        channel: "whatsapp",
        groupId: "123@g.us",
      }),
    ).toBe(true);
    expect(
      resolveChannelGroupRequireMention({
        cfg,
        channel: "whatsapp",
        groupId: "123@g.us",
        configuredGroupDefaultsToNoMention: true,
      }),
    ).toBe(false);
  });
});

describe("resolveToolsBySender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches typed sender IDs", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "id:user:alice": { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "user:alice",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("does not allow senderName collisions to match id keys", () => {
    const victimId = "f4ce8a7d-1111-2222-3333-444455556666";
    expect(
      resolveToolsBySender({
        toolsBySender: {
          [`id:${victimId}`]: { allow: ["exec", "fs.read"] },
          "*": { deny: ["exec"] },
        },
        senderId: "attacker-real-id",
        senderName: victimId,
        senderUsername: "attacker",
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("treats untyped legacy keys as senderId only", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const victimId = "legacy-owner-id";
    expect(
      resolveToolsBySender({
        toolsBySender: {
          [victimId]: { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "attacker-real-id",
        senderName: victimId,
      }),
    ).toEqual({ deny: ["exec"] });

    expect(
      resolveToolsBySender({
        toolsBySender: {
          [victimId]: { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: victimId,
        senderName: "attacker",
      }),
    ).toEqual({ allow: ["exec"] });
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it("matches username keys only against senderUsername", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "username:alice": { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "alice",
        senderUsername: "other-user",
      }),
    ).toEqual({ deny: ["exec"] });

    expect(
      resolveToolsBySender({
        toolsBySender: {
          "username:alice": { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "other-id",
        senderUsername: "@alice",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("matches e164 and name only when explicitly typed", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "e164:+15550001111": { allow: ["exec"] },
          "name:owner": { deny: ["exec"] },
        },
        senderE164: "+15550001111",
        senderName: "owner",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("prefers id over username over name", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "id:alice": { deny: ["exec"] },
          "username:alice": { allow: ["exec"] },
          "name:alice": { allow: ["read"] },
        },
        senderId: "alice",
        senderUsername: "alice",
        senderName: "alice",
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("emits one deprecation warning per legacy key", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const legacyKey = "legacy-warning-key";
    const policy = {
      [legacyKey]: { allow: ["exec"] },
      "*": { deny: ["exec"] },
    };

    resolveToolsBySender({
      toolsBySender: policy,
      senderId: "other-id",
    });
    resolveToolsBySender({
      toolsBySender: policy,
      senderId: "other-id",
    });

    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(String(warningSpy.mock.calls[0]?.[0])).toContain(`toolsBySender key "${legacyKey}"`);
    expect(warningSpy.mock.calls[0]?.[1]).toMatchObject({
      code: "OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY",
    });
  });
});
