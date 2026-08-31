import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuChatType } from "./chat-type.js";
import {
  assertFeishuChatReadAllowed,
  canEnumerateAllFeishuGroups,
  canEnumerateAllFeishuPeers,
  resolveFeishuChatReadPreliminaryAuthorization,
} from "./read-policy.js";
import type { ResolvedFeishuAccount } from "./types.js";

const cfg = { channels: { feishu: {} } } as OpenClawConfig;

function createAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    selectionSource: "fallback",
    enabled: true,
    configured: true,
    domain: "feishu",
    config: {
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
    } as ResolvedFeishuAccount["config"],
  };
}

describe("Feishu read policy", () => {
  it("does not derive conversation kind from public/private visibility", () => {
    expect(resolveFeishuChatType({ chat_type: "private" })).toBeUndefined();
    expect(resolveFeishuChatType({ chat_type: "public" })).toBeUndefined();
    expect(resolveFeishuChatType({ chat_type: "p2p" })).toBe("p2p");
    expect(resolveFeishuChatType({ chat_type: "group" })).toBe("group");
    expect(resolveFeishuChatType({ chat_mode: "group", chat_type: "private" })).toBe("group");
    expect(resolveFeishuChatType({ chat_mode: "p2p", chat_type: "private" })).toBe("p2p");
  });

  it("allows only the trusted current chat when the target type is unknown", () => {
    const account = createAccount();
    const ctx = {
      accountId: "default",
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "feishu",
        currentChannelId: "oc_current",
      },
    };

    expect(
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_current",
        ctx,
      }),
    ).toBe("oc_current");
    expect(() =>
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_other",
        ctx,
      }),
    ).toThrow("Feishu read target is not allowed.");
  });

  it("does not treat public delivery routing as trusted current-chat identity", () => {
    const account = createAccount();

    expect(() =>
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_unconfigured",
        chatType: "group",
        ctx: {
          agentAccountId: "default",
          messageChannel: "feishu",
          deliveryContext: {
            channel: "feishu",
            to: "oc_unconfigured",
            accountId: "default",
          },
        },
      }),
    ).toThrow("Feishu read target is not allowed.");
  });

  it("allows native Feishu ingress to identify the current chat", () => {
    const account = createAccount();

    expect(
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_current",
        chatType: "group",
        ctx: {
          agentAccountId: "default",
          messageChannel: "feishu",
          nativeChannelId: "oc_current",
          deliveryContext: {
            channel: "feishu",
            to: "oc_current",
            accountId: "default",
          },
        },
      }),
    ).toBe("oc_current");
  });

  it("does not treat wildcard group defaults as admission", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      dmPolicy: "open",
      groups: { "*": { requireMention: false } },
    };

    expect(() =>
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_unconfigured",
        ctx: {},
      }),
    ).toThrow("Feishu read target is not allowed.");
  });

  it("requires an effective wildcard before open policy allows non-current DMs", () => {
    const mergedCfg = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "secret_test",
          dmPolicy: "allowlist",
          allowFrom: ["ou_admin"],
          accounts: {
            sales: {
              dmPolicy: "open",
            },
          },
        },
      },
    } as OpenClawConfig;
    const account = resolveFeishuAccount({ cfg: mergedCfg, accountId: "sales" });

    expect(() =>
      assertFeishuChatReadAllowed({
        cfg: mergedCfg,
        account,
        chatId: "oc_other",
        chatType: "p2p",
        ctx: {},
      }),
    ).toThrow("Feishu read target is not allowed.");
    expect(canEnumerateAllFeishuPeers(account)).toBe(false);

    account.config = {
      ...account.config,
      allowFrom: ["ou_admin", "feishu:*"],
    };
    expect(
      assertFeishuChatReadAllowed({
        cfg: mergedCfg,
        account,
        chatId: "oc_other",
        chatType: "p2p",
        ctx: {},
      }),
    ).toBe("oc_other");
    expect(canEnumerateAllFeishuPeers(account)).toBe(true);
  });

  it.each(["allowlist", "pairing"] as const)(
    "honors wildcard DM admission under %s policy",
    (dmPolicy) => {
      const account = createAccount();
      account.config = {
        ...account.config,
        dmPolicy,
        allowFrom: ["feishu:*"],
      };

      expect(
        assertFeishuChatReadAllowed({
          cfg,
          account,
          chatId: "oc_any",
          chatType: "p2p",
          ctx: {},
        }),
      ).toBe("oc_any");
      expect(canEnumerateAllFeishuPeers(account)).toBe(true);
    },
  );

  it("honors wildcard group admission entries", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      groupAllowFrom: ["*"],
    };

    expect(
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_any",
        chatType: "group",
        ctx: {},
      }),
    ).toBe("oc_any");
    expect(canEnumerateAllFeishuGroups(cfg, account)).toBe(true);
  });

  it("uses filtered live enumeration for open groups with explicit denials", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      groupPolicy: "open",
      groups: {
        oc_blocked: { enabled: false },
      },
    };

    expect(canEnumerateAllFeishuGroups(cfg, account)).toBe(true);
  });

  it("uses the global group policy when the provider does not override it", () => {
    const account = createAccount();
    account.config = { dmPolicy: "pairing" } as ResolvedFeishuAccount["config"];
    const globalOpenCfg = {
      channels: {
        defaults: { groupPolicy: "open" },
        feishu: {},
      },
    } as OpenClawConfig;

    expect(
      assertFeishuChatReadAllowed({
        cfg: globalOpenCfg,
        account,
        chatId: "oc_group",
        chatType: "group",
        ctx: {},
      }),
    ).toBe("oc_group");
  });

  it("allows the trusted current DM when groups are disabled", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      groupPolicy: "disabled",
      dmPolicy: "pairing",
    };

    expect(
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_current",
        chatType: "p2p",
        ctx: {
          accountId: "default",
          requesterAccountId: "default",
          toolContext: {
            currentChannelProvider: "feishu",
            currentChannelId: "oc_current",
          },
        },
      }),
    ).toBe("oc_current");
  });

  it("rejects an unclassified current target when group reads are disabled", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      groupPolicy: "disabled",
      dmPolicy: "pairing",
    };

    expect(() =>
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_current",
        ctx: {
          accountId: "default",
          requesterAccountId: "default",
          toolContext: {
            currentChannelProvider: "feishu",
            currentChannelId: "oc_current",
          },
        },
      }),
    ).toThrow("Feishu read target is not allowed.");
  });

  it("lets a direct operator read an unconfigured group or DM", () => {
    const account = createAccount();
    const ctx = { conversationReadOrigin: "direct-operator" as const };

    expect(
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_group",
        chatType: "group",
        ctx,
      }),
    ).toBe("oc_group");
    expect(
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_dm",
        chatType: "p2p",
        ctx,
      }),
    ).toBe("oc_dm");
  });

  it("keeps disabled group targets blocked for direct operators", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      groups: { oc_blocked: { enabled: false } },
    };

    expect(() =>
      assertFeishuChatReadAllowed({
        cfg,
        account,
        chatId: "oc_blocked",
        chatType: "group",
        ctx: { conversationReadOrigin: "direct-operator" },
      }),
    ).toThrow("Feishu read target is not allowed.");
  });

  it("requires metadata only when an unknown target has mixed scope policy", () => {
    const account = createAccount();
    account.config = {
      ...account.config,
      allowFrom: ["*"],
    };

    expect(
      resolveFeishuChatReadPreliminaryAuthorization({
        cfg,
        account,
        chatId: "oc_unknown",
        ctx: {},
      }),
    ).toEqual({ chatId: "oc_unknown", decision: "needs-metadata" });
    expect(
      resolveFeishuChatReadPreliminaryAuthorization({
        cfg,
        account,
        chatId: "oc_unknown",
        ctx: { conversationReadOrigin: "direct-operator" },
      }),
    ).toEqual({ chatId: "oc_unknown", decision: "allow" });
  });
});
