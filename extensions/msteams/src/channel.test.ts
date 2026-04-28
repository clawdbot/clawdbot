import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { msteamsPlugin } from "./channel.js";

function createConfiguredMSTeamsCfg(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "secret",
        tenantId: "tenant-id",
      },
    },
  };
}

describe("msteamsPlugin", () => {
  it("exposes approval auth through approvalCapability", () => {
    expect(msteamsPlugin.approvalCapability).toBe(msTeamsApprovalAuth);
  });

  it("advertises legacy and group-management message-tool actions together", () => {
    const actions = msteamsPlugin.actions?.describeMessageTool?.({
      cfg: createConfiguredMSTeamsCfg(),
    })?.actions;

    expect(actions).toEqual(
      expect.arrayContaining([
        "upload-file",
        "member-info",
        "channel-list",
        "channel-info",
        "addParticipant",
        "removeParticipant",
        "renameGroup",
      ]),
    );
  });

  it("reuses the shared Teams target-id matcher for explicit targets", () => {
    const looksLikeId = msteamsPlugin.messaging?.targetResolver?.looksLikeId;

    expect(looksLikeId?.("29:1a2b3c4d5e6f")).toBe(true);
    expect(looksLikeId?.("a:1bfPersonalChat")).toBe(true);
    expect(looksLikeId?.("user:Jane Doe")).toBe(false);
  });
});

describe("msteams config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    const res = MSTeamsConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit", () => {
    const res = MSTeamsConfigSchema.safeParse({ historyLimit: 4 });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(4);
    }
  });

  it("accepts replyStyle at global/team/channel levels", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "top-level",
      teams: {
        team123: {
          replyStyle: "thread",
          channels: {
            chan456: { replyStyle: "top-level" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.replyStyle).toBe("top-level");
      expect(res.data.teams?.team123?.replyStyle).toBe("thread");
      expect(res.data.teams?.team123?.channels?.chan456?.replyStyle).toBe("top-level");
    }
  });

  it("rejects invalid replyStyle", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "nope",
    });

    expect(res.success).toBe(false);
  });
});

describe("msTeamsApprovalAuth", () => {
  it("authorizes stable Teams user ids and ignores display-name allowlists", () => {
    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg: {
          channels: {
            msteams: {
              allowFrom: ["user:123e4567-e89b-12d3-a456-426614174000"],
            },
          },
        },
        senderId: "123e4567-e89b-12d3-a456-426614174000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg: {
          channels: { msteams: { allowFrom: ["Owner Display"] } },
        },
        senderId: "attacker-aad",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
