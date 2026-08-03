import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";

const sendMocks = vi.hoisted(() => ({
  sendMessageSignal: vi.fn(),
}));

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageSignal: sendMocks.sendMessageSignal,
  };
});

const { deliverReplies } = await import("./monitor.js");

const botAccount = "+15550009999";
const approver = "+15551230000";
const cfg = {
  channels: {
    signal: {
      account: botAccount,
      allowFrom: [approver],
    },
  },
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "signal", to: approver }],
    },
  },
} as OpenClawConfig;

async function deliverReplyPayload(
  payload: ReplyPayload,
  options: {
    config?: OpenClawConfig;
    account?: string;
    accountUuid?: string;
    accountId?: string;
  } = {},
) {
  await deliverReplies({
    cfg: options.config ?? cfg,
    replies: [payload],
    target: approver,
    baseUrl: "http://127.0.0.1:8080",
    account: Object.hasOwn(options, "account") ? options.account : botAccount,
    accountUuid: options.accountUuid,
    accountId: options.accountId ?? "default",
    runtime: { log: vi.fn() } as never,
    maxBytes: 8 * 1024 * 1024,
    textLimit: 4000,
    chunkMode: "length",
  });
}

describe("Signal monitor reply delivery", () => {
  beforeEach(() => {
    clearSignalApprovalReactionTargetsForTest();
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000200",
    });
  });

  it("adds reaction hints and registers structured approval replies delivered by the monitor", async () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-monitor-structured",
      approvalSlug: "exec-mon",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf monitor",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });

    await deliverReplyPayload(payload);

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: approver,
        messageId: "1700000000200",
        reactionKey: "👍",
        targetAuthor: botAccount,
      }),
    ).resolves.toEqual({
      approvalId: "exec-monitor-structured",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: approver,
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
  });

  it("materializes table-only presentation replies", async () => {
    await deliverReplyPayload({
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Targets",
            headers: ["Host", "State"],
            rows: [
              ["alpha", "ready"],
              ["omega", "waiting"],
            ],
          },
        ],
      },
    });

    expect(sendMocks.sendMessageSignal).toHaveBeenCalledTimes(1);
    expect(String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "")).toBe(
      "Targets (table)\n- Host: alpha; State: ready\n- Host: omega; State: waiting",
    );
  });

  it("preserves table presentation alongside plain reply text", async () => {
    await deliverReplyPayload({
      text: "Deployment summary",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Targets",
            headers: ["Host", "State"],
            rows: [
              ["alpha", "ready"],
              ["omega", "waiting"],
            ],
          },
        ],
      },
    });

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).toContain("Deployment summary");
    expect(sentText).toContain("- Host: alpha; State: ready");
    expect(sentText).toContain("- Host: omega; State: waiting");
  });

  it("preserves ordinary control-only presentation fallback text", async () => {
    await deliverReplyPayload({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Retry", action: { type: "command", command: "/retry" } }],
          },
          {
            type: "select",
            placeholder: "Choose",
            options: [{ label: "Later", action: { type: "callback", value: "later" } }],
          },
        ],
      },
    });

    expect(sendMocks.sendMessageSignal).toHaveBeenCalledTimes(1);
    expect(String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "")).toBe(
      "- Retry: `/retry`\n\nChoose:\n- Later",
    );
  });

  it("materializes mixed approval presentations before adding one reaction hint", async () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-monitor-mixed",
      approvalSlug: "exec-monitor-mixed",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf mixed",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    payload.presentation = {
      ...payload.presentation!,
      blocks: [
        { type: "context", text: "Deployment audit context" },
        {
          type: "table",
          caption: "Targets",
          headers: ["Host", "State"],
          rows: [
            ["alpha", "ready"],
            ["omega", "waiting"],
          ],
        },
        ...payload.presentation!.blocks,
      ],
    };

    await deliverReplyPayload(payload);

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).toContain("Deployment audit context");
    expect(sentText).toContain("- Host: alpha; State: ready");
    expect(sentText).toContain("- Host: omega; State: waiting");
    expect(sentText.match(/React with:/g)).toHaveLength(1);
    expect(sentText.match(/\/approve exec-monitor-mixed allow-once/g)).toHaveLength(1);
    expect(sentText.match(/\/approve exec-monitor-mixed deny/g)).toHaveLength(1);
    expect(sentText).not.toContain("- Allow Once:");
    expect(sentText).not.toContain("- Deny:");
  });

  it("registers monitor approval replies for UUID-only linked accounts", async () => {
    const accountUuid = "123e4567-e89b-12d3-a456-426614174000";
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-monitor-uuid",
      approvalSlug: "exec-uuid",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf uuid",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    const uuidOnlyConfig = {
      channels: {
        signal: {
          accounts: {
            default: {
              accountUuid,
              allowFrom: [approver],
            },
          },
        },
      },
      approvals: cfg.approvals,
    } as OpenClawConfig;

    await deliverReplyPayload(payload, {
      config: uuidOnlyConfig,
      account: undefined,
      accountUuid,
      accountId: "default",
    });

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: approver,
        messageId: "1700000000200",
        reactionKey: "👍",
        targetAuthorUuid: accountUuid,
      }),
    ).resolves.toMatchObject({
      approvalId: "exec-monitor-uuid",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("does not bind ordinary monitor replies that quote approval commands", async () => {
    const payload = {
      text: [
        "The docs show this example:",
        "Exec approval required",
        "ID: exec-monitor-quoted",
        "",
        "Reply with: /approve exec-monitor-quoted allow-once|deny",
      ].join("\n"),
    };

    await deliverReplyPayload(payload);

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).not.toContain("React with:");
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: approver,
        messageId: "1700000000200",
        reactionKey: "👍",
        targetAuthor: botAccount,
      }),
    ).resolves.toBeNull();
  });
});
