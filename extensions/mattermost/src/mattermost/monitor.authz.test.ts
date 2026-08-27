// Mattermost tests cover monitor.authz plugin behavior.
import "./monitor-helpers.test-support.js";
import "./monitor-onchar.test-support.js";
import "./monitor.channel-kind.test-support.js";
import { describe, expect, it } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  authorizeMattermostCommandInvocation,
  resolveMattermostMonitorInboundAccess,
  shouldRetainMattermostRecoveredSenderHistory,
} from "./monitor-auth.js";
import type { OpenClawConfig } from "./runtime-api.js";

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  streamingMode: "partial",
  config: {},
};

function authorizeGroupCommand(senderId: string) {
  return authorizeMattermostCommandInvocation({
    account: {
      ...accountFixture,
      config: {
        groupPolicy: "allowlist",
        allowFrom: ["trusted-user"],
      },
    },
    cfg: {},
    senderId,
    senderName: senderId,
    channelId: "chan-1",
    channelInfo: {
      id: "chan-1",
      type: "O",
      name: "general",
      display_name: "General",
    },
    storeAllowFrom: [],
    allowTextCommands: true,
    hasControlCommand: true,
  });
}

describe("mattermost monitor authz", () => {
  it("keeps DM allowlist merged with pairing-store entries", async () => {
    const resolved = await resolveMattermostMonitorInboundAccess({
      account: {
        ...accountFixture,
        config: {
          allowFrom: ["@trusted-user"],
          groupAllowFrom: ["@group-owner"],
        },
      },
      cfg: {},
      senderId: "trusted-user",
      senderName: "Trusted User",
      channelId: "dm-1",
      kind: "direct",
      groupPolicy: "allowlist",
      storeAllowFrom: ["user:attacker"],
      allowTextCommands: false,
      hasControlCommand: false,
    });

    expect(resolved.senderAccess.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
  });

  it("uses explicit groupAllowFrom without pairing-store inheritance", async () => {
    const resolved = await resolveMattermostMonitorInboundAccess({
      account: {
        ...accountFixture,
        config: {
          allowFrom: ["@trusted-user"],
          groupAllowFrom: ["@group-owner"],
        },
      },
      cfg: {},
      senderId: "group-owner",
      senderName: "Group Owner",
      channelId: "chan-1",
      kind: "channel",
      groupPolicy: "allowlist",
      storeAllowFrom: ["user:attacker"],
      allowTextCommands: false,
      hasControlCommand: false,
    });

    expect(resolved.senderAccess.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });

  it("falls group allowlist back to allowFrom without pairing-store entries", async () => {
    const resolved = await resolveMattermostMonitorInboundAccess({
      account: {
        ...accountFixture,
        config: {
          allowFrom: ["@trusted-user"],
        },
      },
      cfg: {},
      senderId: "trusted-user",
      senderName: "Trusted User",
      channelId: "chan-1",
      kind: "channel",
      groupPolicy: "allowlist",
      storeAllowFrom: ["user:attacker"],
      allowTextCommands: false,
      hasControlCommand: false,
    });

    expect(resolved.senderAccess.effectiveGroupAllowFrom).toEqual(["trusted-user"]);
  });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const access = await resolveMattermostMonitorInboundAccess({
      account: {
        ...accountFixture,
        config: {
          dmPolicy: "open",
        },
      },
      cfg: {},
      senderId: "alice",
      senderName: "Alice",
      channelId: "dm-1",
      kind: "direct",
      groupPolicy: "allowlist",
      storeAllowFrom: [],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(access.ingress.decision).toBe("block");
    expect(access.commandAccess.authorized).toBe(false);
  });

  it("denies group control commands when the sender is outside the allowlist", async () => {
    const decision = await authorizeGroupCommand("attacker");

    expect(decision).toEqual({
      ok: false,
      denyReason: "unauthorized",
      commandAuthorized: false,
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "general",
        display_name: "General",
      },
      kind: "channel",
      chatType: "channel",
      channelName: "general",
      channelDisplay: "General",
      roomLabel: "#general",
    });
  });

  it("authorizes group control commands for allowlisted senders", async () => {
    const decision = await authorizeGroupCommand("trusted-user");

    expect(decision).toEqual({
      ok: true,
      commandAuthorized: true,
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "general",
        display_name: "General",
      },
      kind: "channel",
      chatType: "channel",
      channelName: "general",
      channelDisplay: "General",
      roomLabel: "#general",
    });
  });

  it("denies command invocations when channel type is unavailable", async () => {
    const decision = await authorizeMattermostCommandInvocation({
      account: {
        ...accountFixture,
        config: {
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["trusted-user"],
        },
      },
      cfg: {},
      senderId: "new-user",
      senderName: "New User",
      channelId: "dm-1",
      channelInfo: {
        id: "dm-1",
        name: "",
        display_name: "",
      },
      storeAllowFrom: [],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(decision).toEqual({
      ok: false,
      denyReason: "unknown-channel",
      commandAuthorized: false,
      channelInfo: {
        id: "dm-1",
        name: "",
        display_name: "",
      },
      kind: "channel",
      chatType: "channel",
      channelName: "",
      channelDisplay: "",
      roomLabel: "#dm-1",
    });
  });

  it("authorizes group senders through static access groups", async () => {
    const decision = await authorizeMattermostCommandInvocation({
      account: {
        ...accountFixture,
        config: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["accessGroup:oncall"],
        },
      },
      cfg: {
        accessGroups: {
          oncall: {
            type: "message.senders",
            members: {
              mattermost: ["mattermost:trusted-user"],
            },
          },
        },
      },
      senderId: "trusted-user",
      senderName: "Trusted User",
      channelId: "chan-1",
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "general",
        display_name: "General",
      },
      storeAllowFrom: [],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(decision).toEqual({
      ok: true,
      commandAuthorized: true,
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "general",
        display_name: "General",
      },
      kind: "channel",
      chatType: "channel",
      channelName: "general",
      channelDisplay: "General",
      roomLabel: "#general",
    });
  });

  it("fails direct reaction access without pairing admission", async () => {
    const access = await resolveMattermostMonitorInboundAccess({
      account: {
        ...accountFixture,
        config: {
          dmPolicy: "pairing",
        },
      },
      cfg: {},
      senderId: "new-user",
      senderName: "New User",
      channelId: "dm-1",
      kind: "direct",
      groupPolicy: "allowlist",
      storeAllowFrom: [],
      allowTextCommands: false,
      hasControlCommand: false,
      eventKind: "reaction",
      mayPair: false,
    });

    expect(access.ingress.decision).toBe("block");
    expect(access.ingress.reasonCode).toBe("event_pairing_not_allowed");
  });
});

// Thread recovery (#93204) reads posts the live handler never saw, so its
// retention decision has to be the effective ingress policy — not a re-derived
// allowlist, which omits history from senders the real path authorizes.
describe("mattermost recovered thread history visibility", () => {
  const allowlistVisibility: OpenClawConfig = {
    channels: { mattermost: { contextVisibility: "allowlist" } },
  };

  const retains = (params: {
    cfg?: OpenClawConfig;
    config: ResolvedMattermostAccount["config"];
    senderId: string;
    kind?: "direct" | "group" | "channel";
    storeAllowFrom?: Array<string | number>;
  }) =>
    shouldRetainMattermostRecoveredSenderHistory({
      account: { ...accountFixture, config: params.config },
      cfg: params.cfg ?? allowlistVisibility,
      senderId: params.senderId,
      channelId: params.kind === "direct" ? "dm-1" : "chan-1",
      kind: params.kind ?? "channel",
      groupPolicy: "allowlist",
      storeAllowFrom: params.storeAllowFrom ?? [],
    });

  it("keeps every recovered sender when visibility does not hide history", async () => {
    // The permissive default asks nothing of the allowlist, so a thread is
    // recovered whole.
    await expect(
      retains({ cfg: {}, config: { groupAllowFrom: ["@group-owner"] }, senderId: "stranger" }),
    ).resolves.toBe(true);
  });

  it("falls an empty group allowlist back to allowFrom", async () => {
    // The regression: an empty `groupAllowFrom` is absent, not a deny-all, so a
    // sender the live path admits through `allowFrom` keeps their history.
    await expect(
      retains({
        config: { allowFrom: ["@trusted-user"], groupAllowFrom: [] },
        senderId: "trusted-user",
      }),
    ).resolves.toBe(true);
  });

  it("keeps history from senders authorized through an access group", async () => {
    await expect(
      retains({
        cfg: {
          ...allowlistVisibility,
          accessGroups: {
            oncall: {
              type: "message.senders",
              members: { mattermost: ["mattermost:trusted-user"] },
            },
          },
        },
        config: { groupAllowFrom: ["accessGroup:oncall"] },
        senderId: "trusted-user",
      }),
    ).resolves.toBe(true);
  });

  it("keeps direct history from a sender admitted by the pairing store", async () => {
    await expect(
      retains({
        config: { dmPolicy: "pairing" },
        senderId: "paired-user",
        kind: "direct",
        storeAllowFrom: ["user:paired-user"],
      }),
    ).resolves.toBe(true);
  });

  it("drops history from a sender the effective policy does not authorize", async () => {
    await expect(
      retains({
        config: { allowFrom: ["@trusted-user"], groupAllowFrom: [] },
        senderId: "stranger",
      }),
    ).resolves.toBe(false);
  });

  it("does not admit a recovered direct sender through pairing", async () => {
    // Appearing in a recovered thread must never count as pairing admission.
    await expect(
      retains({ config: { dmPolicy: "pairing" }, senderId: "new-user", kind: "direct" }),
    ).resolves.toBe(false);
  });

  it("drops history when the sender id is missing", async () => {
    await expect(retains({ config: { allowFrom: ["*"] }, senderId: "" })).resolves.toBe(false);
  });
});
