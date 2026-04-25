import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";

vi.mock("./exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: vi.fn(
    (params: {
      channel?: string | null;
      channelLabel?: string | null;
      accountId?: string | null;
    }) => {
      const channel = (params.channel ?? "").trim().toLowerCase();
      const label = params.channelLabel ?? channel;
      const accountId = params.accountId?.trim();
      const accountPrefix =
        accountId && accountId !== "default"
          ? `channels.${channel}.accounts.${accountId}`
          : `channels.${channel}`;
      if (channel === "matrix") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\` or \`${accountPrefix}.dm.allowFrom\`; leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      if (channel === "discord") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      if (channel === "slack") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      if (channel === "telegram") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\`; if you leave it unset, OpenClaw can infer numeric owner IDs from \`${accountPrefix}.allowFrom\` or direct-message \`${accountPrefix}.defaultTo\` when possible. Leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      return null;
    },
  ),
  listNativeExecApprovalClientLabels: vi.fn(() => ["Discord", "Matrix", "Slack", "Telegram"]),
  supportsNativeExecApprovalClient: vi.fn((channel?: string | null) =>
    ["discord", "matrix", "slack", "telegram"].includes((channel ?? "").trim().toLowerCase()),
  ),
}));

import {
  buildExecApprovalActionDescriptors,
  buildExecApprovalCommandText,
  buildExecApprovalInteractiveReply,
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
} from "./exec-approval-reply.js";

describe("exec approval reply helpers", () => {
  const invalidReplyMetadataCases = [
    { name: "empty object", payload: {} },
    { name: "null channelData", payload: { channelData: null } },
    { name: "array channelData", payload: { channelData: [] } },
    { name: "null execApproval", payload: { channelData: { execApproval: null } } },
    { name: "array execApproval", payload: { channelData: { execApproval: [] } } },
    {
      name: "blank approval slug",
      payload: { channelData: { execApproval: { approvalId: "req-1", approvalSlug: "  " } } },
    },
    {
      name: "blank approval id",
      payload: { channelData: { execApproval: { approvalId: "  ", approvalSlug: "slug-1" } } },
    },
  ] as const;

  const unavailableReasonCases = [
    {
      reason: "initiating-platform-disabled" as const,
      channelLabel: "Slack",
      expected:
        "Exec approval is required, but native chat exec approvals are not configured on Slack.",
    },
    {
      reason: "initiating-platform-unsupported" as const,
      channelLabel: undefined,
      expected:
        "Exec approval is required, but this platform does not support chat exec approvals.",
    },
    {
      reason: "no-approval-route" as const,
      channelLabel: undefined,
      expected:
        "Exec approval is required, but no interactive approval client is currently available.",
    },
  ] as const;

  it("returns the approver DM notice text", () => {
    expect(getExecApprovalApproverDmNoticeText()).toBe(
      "Approval required. I sent approval DMs to the approvers for this account.",
    );
  });

  it("mentions Matrix in the fallback native approval guidance", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    }).text;
    expect(text).toContain("native chat approval client such as");
    expect(text).toContain("Discord");
    expect(text).toContain("Matrix");
    expect(text).toContain("Slack");
    expect(text).toContain("Telegram");
  });

  it("avoids repeating allowFrom guidance in the no-route fallback", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    }).text;

    expect(text).not.toContain(
      "Then retry the command. If those accounts already know your owner ID via allowFrom or owner config",
    );
    expect(text).toContain(
      "You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.",
    );
  });

  it("explains how to enable Matrix native approvals when Matrix is the initiating platform", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      channel: "matrix",
      channelLabel: "Matrix",
    }).text;

    expect(text).toContain("native chat exec approvals are not configured on Matrix");
    expect(text).toContain("Matrix supports native exec approvals for this account");
    expect(text).toContain("`channels.matrix.execApprovals.approvers`");
    expect(text).toContain("`channels.matrix.dm.allowFrom`");
  });

  it.each([
    {
      channel: "discord",
      channelLabel: "Discord",
      expected: "`commands.ownerAllowFrom`",
      unexpected: "`channels.discord.dm.allowFrom`",
    },
    {
      channel: "slack",
      channelLabel: "Slack",
      expected: "`commands.ownerAllowFrom`",
      unexpected: "`channels.slack.dm.allowFrom`",
    },
    {
      channel: "telegram",
      channelLabel: "Telegram",
      expected: "`channels.telegram.allowFrom`",
      unexpected: "`channels.telegram.dm.allowFrom`",
    },
  ])(
    "uses channel-specific disabled setup guidance for $channelLabel",
    ({ channel, channelLabel, expected, unexpected }) => {
      const text = buildExecApprovalUnavailableReplyPayload({
        reason: "initiating-platform-disabled",
        channel,
        channelLabel,
      }).text;

      expect(text).toContain(expected);
      expect(text).not.toContain(unexpected);
    },
  );

  it.each([
    {
      channel: "discord",
      channelLabel: "Discord",
      accountId: "work",
      expected: "`channels.discord.accounts.work.execApprovals.approvers`",
      unexpected: "`channels.discord.execApprovals.approvers`",
    },
    {
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work",
      expected: "`channels.slack.accounts.work.execApprovals.approvers`",
      unexpected: "`channels.slack.execApprovals.approvers`",
    },
    {
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "work",
      expected: "`channels.telegram.accounts.work.allowFrom`",
      unexpected: "`channels.telegram.allowFrom`",
    },
    {
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "work",
      expected: "`channels.matrix.accounts.work.dm.allowFrom`",
      unexpected: "`channels.matrix.dm.allowFrom`",
    },
  ])(
    "uses account-scoped disabled setup guidance for $channelLabel named account",
    ({ channel, channelLabel, accountId, expected, unexpected }) => {
      const text = buildExecApprovalUnavailableReplyPayload({
        reason: "initiating-platform-disabled",
        channel,
        channelLabel,
        accountId,
      }).text;

      expect(text).toContain(expected);
      expect(text).not.toContain(unexpected);
    },
  );

  it.each(invalidReplyMetadataCases)(
    "returns null for invalid reply metadata payload: $name",
    ({ payload }) => {
      expect(getExecApprovalReplyMetadata(payload as ReplyPayload)).toBeNull();
    },
  );

  it("normalizes reply metadata and filters invalid decisions", () => {
    expect(
      getExecApprovalReplyMetadata({
        channelData: {
          execApproval: {
            approvalId: " req-1 ",
            approvalSlug: " slug-1 ",
            agentId: " agent-1 ",
            allowedDecisions: ["allow-once", "bad", "deny", "allow-always", 3],
            sessionKey: " session-1 ",
          },
        },
      }),
    ).toEqual({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      approvalKind: "exec",
      agentId: "agent-1",
      allowedDecisions: ["allow-once", "deny", "allow-always"],
      sessionKey: "session-1",
    });
  });

  it("builds pending reply payloads with trimmed warning text and slug fallback", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      warningText: "  Heads up.  ",
      approvalId: "req-1",
      approvalSlug: "slug-1",
      command: "echo ok",
      cwd: "/tmp/work",
      host: "gateway",
      nodeId: "node-1",
      expiresAtMs: 2500,
      nowMs: 1000,
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-1",
        approvalSlug: "slug-1",
        approvalKind: "exec",
        agentId: undefined,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: undefined,
      },
    });
    expect(payload.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              value: "/approve req-1 allow-once",
              style: "success",
            },
            {
              label: "Allow Always",
              value: "/approve req-1 allow-always",
              style: "primary",
            },
            {
              label: "Deny",
              value: "/approve req-1 deny",
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.text).toContain("Heads up.");
    expect(payload.text).toContain("```txt\n/approve slug-1 allow-once\n```");
    expect(payload.text).toContain("```sh\necho ok\n```");
    expect(payload.text).toContain("Host: gateway\nNode: node-1\nCWD: /tmp/work\nExpires in: 2s");
    expect(payload.text).toContain("Full id: `req-1`");
  });

  it("compacts structured cwd paths in pending reply payloads", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-home",
      approvalSlug: "slug-home",
      command: "pwd",
      cwd: "C:\\Users\\alice\\project",
      host: "gateway",
    });

    expect(payload.text).toContain("CWD: ~/project");
    expect(payload.text).not.toContain("C:\\Users\\alice");
  });

  it("omits allow-always actions when the effective policy requires approval every time", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-ask-always",
      approvalSlug: "slug-always",
      ask: "always",
      command: "echo ok",
      host: "gateway",
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-ask-always",
        approvalSlug: "slug-always",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    expect(payload.text).toContain("```txt\n/approve slug-always allow-once\n```");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.text).toContain(
      "The effective approval policy requires approval every time, so Allow Always is unavailable.",
    );
    expect(payload.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              value: "/approve req-ask-always allow-once",
              style: "success",
            },
            {
              label: "Deny",
              value: "/approve req-ask-always deny",
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("stores agent and session metadata for downstream suppression checks", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-meta",
      approvalSlug: "slug-meta",
      agentId: "ops-agent",
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      command: "echo ok",
      host: "gateway",
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-meta",
        approvalSlug: "slug-meta",
        approvalKind: "exec",
        agentId: "ops-agent",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      },
    });
  });

  it("uses a longer fence for commands containing triple backticks", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-2",
      approvalSlug: "slug-2",
      approvalCommandId: " req-cmd-2 ",
      command: "echo ```danger```",
      host: "sandbox",
    });

    expect(payload.text).toContain("```txt\n/approve req-cmd-2 allow-once\n```");
    expect(payload.text).toContain("````sh\necho ```danger```\n````");
    expect(payload.text).not.toContain("Expires in:");
  });

  it("clamps pending reply expiration to zero seconds", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-3",
      approvalSlug: "slug-3",
      command: "echo later",
      host: "gateway",
      expiresAtMs: 1000,
      nowMs: 3000,
    });

    expect(payload.text).toContain("Expires in: 0s");
  });

  it("formats longer approval windows in minutes", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-30m",
      approvalSlug: "slug-30m",
      command: "echo later",
      host: "gateway",
      expiresAtMs: 1_801_000,
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Expires in: 30m");
  });

  it("builds shared exec approval action descriptors and interactive replies", () => {
    expect(
      buildExecApprovalActionDescriptors({
        approvalCommandId: "req-1",
      }),
    ).toEqual([
      {
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve req-1 allow-once",
      },
      {
        decision: "allow-always",
        label: "Allow Always",
        style: "primary",
        command: "/approve req-1 allow-always",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve req-1 deny",
      },
    ]);

    expect(
      buildExecApprovalInteractiveReply({
        approvalCommandId: "req-1",
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Allow Once", value: "/approve req-1 allow-once", style: "success" },
            { label: "Allow Always", value: "/approve req-1 allow-always", style: "primary" },
            { label: "Deny", value: "/approve req-1 deny", style: "danger" },
          ],
        },
      ],
    });
  });

  it("builds and parses shared exec approval command text", () => {
    expect(
      buildExecApprovalCommandText({
        approvalCommandId: "req-1",
        decision: "allow-always",
      }),
    ).toBe("/approve req-1 allow-always");

    expect(parseExecApprovalCommandText("/approve req-1 deny")).toEqual({
      approvalId: "req-1",
      decision: "deny",
    });
    expect(parseExecApprovalCommandText("approve req-1 allow-once")).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(parseExecApprovalCommandText("/approve@clover req-1 allow-once")).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(parseExecApprovalCommandText("  /approve req-1 always")).toEqual({
      approvalId: "req-1",
      decision: "allow-always",
    });
    expect(parseExecApprovalCommandText("/approve req-1 allow-always")).toEqual({
      approvalId: "req-1",
      decision: "allow-always",
    });
    expect(parseExecApprovalCommandText("/approve req-1 maybe")).toBeNull();
  });

  it("builds unavailable payloads for approver DMs", () => {
    expect(
      buildExecApprovalUnavailableReplyPayload({
        warningText: "  Careful.  ",
        reason: "no-approval-route",
        sentApproverDms: true,
      }),
    ).toEqual({
      text: "Careful.\n\nApproval required. I sent approval DMs to the approvers for this account.",
    });
  });

  it.each(unavailableReasonCases)(
    "builds unavailable payload for reason $reason",
    ({ reason, channelLabel, expected }) => {
      expect(
        buildExecApprovalUnavailableReplyPayload({
          reason,
          channelLabel,
        }).text,
      ).toContain(expected);
    },
  );
});
