import { describe, expect, it } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  authorizeMattermostCommandInvocation,
  resolveMattermostMonitorInboundAccess,
} from "./monitor-auth.js";

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
    cfg: {
      commands: {
        useAccessGroups: true,
      },
    },
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
      cfg: {
        commands: {
          useAccessGroups: true,
        },
      },
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
        commands: {
          useAccessGroups: true,
        },
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
