import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { normalizeZaloAllowEntry, resolveZaloRuntimeGroupPolicy } from "./group-access.js";
import type { ZaloAccountConfig } from "./types.js";

function stringEntries(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => String(entry));
}

const groupPolicyCases: Array<[string, ZaloAccountConfig, string, boolean, string]> = [
  [
    "disabled policy",
    { groupPolicy: "disabled", groupAllowFrom: ["zalo:123"] },
    "123",
    false,
    "group_policy_disabled",
  ],
  [
    "empty allowlist",
    { groupPolicy: "allowlist", groupAllowFrom: [] },
    "attacker",
    false,
    "group_policy_empty_allowlist",
  ],
  [
    "allowlist mismatch",
    { groupPolicy: "allowlist", groupAllowFrom: ["zalo:victim-user-001"] },
    "attacker-user-999",
    false,
    "group_policy_not_allowlisted",
  ],
  [
    "Zalo prefix match",
    { groupPolicy: "allowlist", groupAllowFrom: ["zl:12345"] },
    "12345",
    true,
    "group_policy_allowed",
  ],
  [
    "allowFrom fallback",
    { groupPolicy: "allowlist", allowFrom: ["zl:12345"], groupAllowFrom: [] },
    "12345",
    true,
    "group_policy_allowed",
  ],
  [
    "open policy",
    { groupPolicy: "open", groupAllowFrom: [] },
    "attacker-user-999",
    true,
    "group_policy_open",
  ],
];

async function resolveAccess(
  params: {
    cfg?: OpenClawConfig;
    accountConfig?: ZaloAccountConfig;
    providerConfigPresent?: boolean;
    defaultGroupPolicy?: GroupPolicy;
    isGroup?: boolean;
    senderId?: string;
    rawBody?: string;
    storeAllowFrom?: string[];
    shouldComputeCommandAuthorized?: boolean;
  } = {},
) {
  const readAllowFromStore = vi.fn(async () => params.storeAllowFrom ?? []);
  const accountConfig = {
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    allowFrom: [],
    groupAllowFrom: [],
    ...params.accountConfig,
  } satisfies ZaloAccountConfig;
  const { groupPolicy, providerMissingFallbackApplied } = resolveZaloRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent ?? true,
    groupPolicy: accountConfig.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy ?? "open",
  });
  const shouldComputeAuth = params.shouldComputeCommandAuthorized ?? false;
  const isGroup = params.isGroup ?? true;
  const result = await resolveStableChannelMessageIngress({
    channelId: "zalo",
    accountId: "default",
    identity: {
      key: "zalo-user-id",
      normalize: normalizeZaloAllowEntry,
      sensitivity: "pii",
      entryIdPrefix: "zalo-entry",
    },
    accessGroups: params.cfg?.accessGroups,
    readStoreAllowFrom: async () => await readAllowFromStore(),
    useAccessGroups: params.cfg?.commands?.useAccessGroups !== false,
    subject: { stableId: params.senderId ?? "123" },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: "chat-1",
    },
    providerMissingFallbackApplied,
    dmPolicy: accountConfig.dmPolicy ?? "pairing",
    groupPolicy,
    policy: { groupAllowFromFallbackToAllowFrom: true },
    allowFrom: stringEntries(accountConfig.allowFrom),
    groupAllowFrom: stringEntries(accountConfig.groupAllowFrom),
    command: shouldComputeAuth ? {} : undefined,
  });
  return { result, readAllowFromStore };
}

function stableSenderAccess(access: { allowed: boolean; decision: string; reasonCode: string }) {
  return {
    allowed: access.allowed,
    decision: access.decision,
    reasonCode: access.reasonCode,
  };
}

describe("zalo shared ingress access policy", () => {
  it.each(groupPolicyCases)(
    "maps %s through shared ingress",
    async (_name, accountConfig, senderId, allowed, reasonCode) => {
      const { result } = await resolveAccess({ accountConfig, senderId });
      expect(stableSenderAccess(result.senderAccess)).toEqual({
        allowed,
        decision: allowed ? "allow" : "block",
        reasonCode,
      });
    },
  );

  it("keeps group control-command authorization separate from group sender access", async () => {
    const { result } = await resolveAccess({
      accountConfig: {
        groupPolicy: "open",
        allowFrom: [],
        groupAllowFrom: [],
      },
      rawBody: "/reset",
      shouldComputeCommandAuthorized: true,
    });

    expect(result.senderAccess.decision).toBe("allow");
    expect(result.commandAccess.authorized).toBe(false);
  });

  it("authorizes direct commands from the pairing store", async () => {
    const { result, readAllowFromStore } = await resolveAccess({
      isGroup: false,
      accountConfig: {
        dmPolicy: "pairing",
        allowFrom: [],
      },
      senderId: "12345",
      storeAllowFrom: ["zl:12345"],
      rawBody: "/status",
      shouldComputeCommandAuthorized: true,
    });

    expect(readAllowFromStore).toHaveBeenCalledTimes(1);
    expect(stableSenderAccess(result.senderAccess)).toEqual({
      allowed: true,
      decision: "allow",
      reasonCode: "dm_policy_allowlisted",
    });
    expect(result.commandAccess.authorized).toBe(true);
  });

  it("requires an explicit wildcard or allowlist match for open DMs", async () => {
    const { result, readAllowFromStore } = await resolveAccess({
      isGroup: false,
      accountConfig: {
        dmPolicy: "open",
        allowFrom: [],
      },
      senderId: "12345",
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
    expect(stableSenderAccess(result.senderAccess)).toEqual({
      allowed: false,
      decision: "block",
      reasonCode: "dm_policy_not_allowlisted",
    });
  });

  it("matches static access-group entries through the shared ingress resolver", async () => {
    const { result } = await resolveAccess({
      cfg: {
        accessGroups: {
          operators: {
            type: "message.senders",
            members: {
              zalo: ["zl:12345"],
            },
          },
        },
      },
      accountConfig: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
      },
      senderId: "12345",
    });

    expect(stableSenderAccess(result.senderAccess)).toEqual({
      allowed: true,
      decision: "allow",
      reasonCode: "group_policy_allowed",
    });
  });
});
