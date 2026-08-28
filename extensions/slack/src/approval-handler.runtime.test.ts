// Slack tests cover approval handler plugin behavior.
import type {
  ApprovalActionView,
  ChannelApprovalKind,
  ApprovalMetadataView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it, vi } from "vitest";
import { decodeSlackApprovalAction } from "./approval-actions.js";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

type SlackPayload = {
  text: string;
  blocks?: unknown;
};
type ChatUpdatePayload = {
  channel?: string;
  ts?: string;
  text?: string;
  blocks?: unknown;
};
type SlackUpdateEntryParams = Parameters<
  NonNullable<typeof slackApprovalNativeRuntime.transport.updateEntry>
>[0];
const SLACK_CHAT_UPDATE_TEXT_MAX_BYTES = 4000;
const APPROVAL_TIMING = {
  createdAtMs: 0,
  expiresAtMs: 60_000,
};
const APPROVAL_CONTEXT = {
  cfg: {} as never,
  accountId: "default",
  context: {
    app: {} as never,
    config: {} as never,
  },
};
const APPROVAL_ENTRY = {
  channelId: "D123APPROVER",
  messageTs: "1712345678.999999",
};
const SCREEN_SHARE_APPROVAL = {
  approvalKind: "plugin" as const,
  approvalId: "plugin:req-1",
  title: "Share screen with Computer Use",
  description: "Computer Use wants to inspect the desktop.",
  severity: "warning" as const,
  pluginId: "computer-use",
  toolName: "screenshot",
  metadata: [{ label: "Plugin", value: "computer-use" }],
};
const SCREEN_SHARE_REQUEST = {
  id: SCREEN_SHARE_APPROVAL.approvalId,
  request: {
    title: SCREEN_SHARE_APPROVAL.title,
    description: SCREEN_SHARE_APPROVAL.description,
  },
  ...APPROVAL_TIMING,
};

type ApprovalDecision = ApprovalActionView["decision"];

const ACTION_PRESENTATION = {
  "allow-once": { label: "Allow Once", style: "success" },
  "allow-always": { label: "Allow Always", style: "success" },
  deny: { label: "Deny", style: "danger" },
} as const satisfies Record<ApprovalDecision, Pick<ApprovalActionView, "label" | "style">>;

function buildApprovalAction(
  approvalKind: ChannelApprovalKind,
  approvalId: string,
  decision: ApprovalDecision,
): ApprovalActionView {
  return {
    decision,
    ...ACTION_PRESENTATION[decision],
    action: { type: "approval", approvalId, approvalKind, decision },
    command: `/approve ${approvalId} ${decision}`,
  };
}

async function buildExecPendingPayload(params: {
  approvalId: string;
  commandText: string;
  metadata?: ApprovalMetadataView[];
  decisions?: ApprovalDecision[];
}): Promise<SlackPayload> {
  const decisions = params.decisions ?? ["allow-once"];
  return (await slackApprovalNativeRuntime.presentation.buildPendingPayload({
    ...APPROVAL_CONTEXT,
    request: {
      id: params.approvalId,
      request: { command: params.commandText },
      ...APPROVAL_TIMING,
    },
    approvalKind: "exec",
    nowMs: 0,
    view: {
      approvalKind: "exec",
      approvalId: params.approvalId,
      commandText: params.commandText,
      metadata: params.metadata ?? [],
      actions: decisions.map((decision) =>
        buildApprovalAction("exec", params.approvalId, decision),
      ),
    } as never,
  })) as SlackPayload;
}

async function buildPluginPendingPayload(params: {
  approvalId: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  pluginId: string;
  toolName: string;
  metadata?: ApprovalMetadataView[];
  decisions?: ApprovalDecision[];
}): Promise<SlackPayload> {
  const decisions = params.decisions ?? ["deny"];
  return (await slackApprovalNativeRuntime.presentation.buildPendingPayload({
    ...APPROVAL_CONTEXT,
    request: {
      id: params.approvalId,
      request: { title: params.title, description: params.description },
      ...APPROVAL_TIMING,
    },
    approvalKind: "plugin",
    nowMs: 0,
    view: {
      approvalKind: "plugin",
      phase: "pending",
      approvalId: params.approvalId,
      title: params.title,
      description: params.description,
      severity: params.severity,
      pluginId: params.pluginId,
      toolName: params.toolName,
      metadata: params.metadata ?? [],
      actions: decisions.map((decision) =>
        buildApprovalAction("plugin", params.approvalId, decision),
      ),
      expiresAtMs: APPROVAL_TIMING.expiresAtMs,
    },
  })) as SlackPayload;
}

function buildExecResolvedResult() {
  return slackApprovalNativeRuntime.presentation.buildResolvedResult({
    ...APPROVAL_CONTEXT,
    request: {
      id: "req-1",
      request: { command: "echo hi" },
      ...APPROVAL_TIMING,
    },
    resolved: {
      id: "req-1",
      decision: "allow-once",
      resolvedBy: "U123APPROVER",
      ts: 0,
    } as never,
    view: {
      approvalKind: "exec",
      approvalId: "req-1",
      decision: "allow-once",
      commandText: "echo hi",
      resolvedBy: "U123APPROVER",
    } as never,
    entry: APPROVAL_ENTRY,
  });
}

function buildExecExpiredResult() {
  return slackApprovalNativeRuntime.presentation.buildExpiredResult({
    ...APPROVAL_CONTEXT,
    request: {
      id: "req-1",
      request: { command: "echo hi" },
      ...APPROVAL_TIMING,
    },
    view: {
      approvalKind: "exec",
      approvalId: "req-1",
      phase: "expired",
      commandText: "echo hi",
      metadata: [],
    } as never,
    entry: APPROVAL_ENTRY,
  });
}

function buildPluginResolvedResult() {
  return slackApprovalNativeRuntime.presentation.buildResolvedResult({
    ...APPROVAL_CONTEXT,
    request: SCREEN_SHARE_REQUEST,
    resolved: {
      id: SCREEN_SHARE_APPROVAL.approvalId,
      decision: "allow-once",
      resolvedBy: "U123APPROVER",
      ts: 0,
    } as never,
    view: {
      ...SCREEN_SHARE_APPROVAL,
      phase: "resolved",
      decision: "allow-once",
      resolvedBy: "U123APPROVER",
    },
    entry: APPROVAL_ENTRY,
  });
}

function buildPluginExpiredResult() {
  return slackApprovalNativeRuntime.presentation.buildExpiredResult({
    ...APPROVAL_CONTEXT,
    request: SCREEN_SHARE_REQUEST,
    view: {
      ...SCREEN_SHARE_APPROVAL,
      phase: "expired",
    },
    entry: APPROVAL_ENTRY,
  });
}

function findSlackActionsBlock(blocks: Array<{ type?: string; elements?: unknown[] }>) {
  return blocks.find((block) => block.type === "actions");
}

function readSlackActionLabels(block: { elements?: unknown[] } | undefined): string[] {
  return (block?.elements ?? []).map((element) => {
    const text = (element as { text?: { text?: unknown } } | null)?.text?.text;
    return typeof text === "string" ? text : "";
  });
}

function decodeSlackApprovalElements(block: { elements?: unknown[] } | undefined) {
  return (block?.elements ?? []).map((element) =>
    decodeSlackApprovalAction(
      element && typeof element === "object" ? (element as { value?: unknown }).value : undefined,
    ),
  );
}

function readChatUpdatePayload(
  chatUpdate: { mock: { calls: unknown[][] } },
  index: number,
): ChatUpdatePayload {
  const call = chatUpdate.mock.calls[index];
  if (!call) {
    throw new Error(`Expected Slack chat.update call #${index + 1}`);
  }
  const [payload] = call;
  if (!payload || typeof payload !== "object") {
    throw new Error(`Expected Slack chat.update payload #${index + 1}`);
  }
  return payload as ChatUpdatePayload;
}

async function updateSlackApprovalEntry(
  context: SlackUpdateEntryParams["context"],
  payload: SlackUpdateEntryParams["payload"],
): Promise<void> {
  await slackApprovalNativeRuntime.transport.updateEntry?.({
    ...APPROVAL_CONTEXT,
    context,
    entry: { channelId: "C123", messageTs: "1712345678.999999" },
    payload,
    phase: "resolved",
  });
}

const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function readMrkdwnTexts(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) {
    return [];
  }

  const texts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const text = (block as { text?: unknown }).text;
    if (
      text &&
      typeof text === "object" &&
      (text as { type?: unknown }).type === "mrkdwn" &&
      typeof (text as { text?: unknown }).text === "string"
    ) {
      texts.push((text as { text: string }).text);
    }

    const elements = (block as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) {
      continue;
    }
    for (const element of elements) {
      if (
        element &&
        typeof element === "object" &&
        (element as { type?: unknown }).type === "mrkdwn" &&
        typeof (element as { text?: unknown }).text === "string"
      ) {
        texts.push((element as { text: string }).text);
      }
    }
  }

  return texts;
}

function findApprovalMrkdwn(payload: SlackPayload, prefix: string): string {
  const text = readMrkdwnTexts(payload.blocks).find((entry) => entry.startsWith(prefix));
  if (!text) {
    throw new Error(`Expected Slack mrkdwn block starting with ${prefix}`);
  }
  return text;
}

describe("slackApprovalNativeRuntime", () => {
  it("subscribes to plugin approval events", () => {
    expect(slackApprovalNativeRuntime.eventKinds).toEqual(["exec", "plugin"]);
  });

  it("does not leave dangling surrogates when truncating exec approval command mrkdwn", async () => {
    const commandText = `${"a".repeat(2598)}😀tail`;
    const payload = await buildExecPendingPayload({
      approvalId: "req-surrogate",
      commandText,
    });

    const commandMrkdwn = findApprovalMrkdwn(payload, "*Command*");
    expect(commandMrkdwn).toMatch(/…\n```$/);
    expect(UNPAIRED_SURROGATE_RE.test(commandMrkdwn)).toBe(false);
  });

  it("does not leave dangling surrogates when truncating plugin approval request mrkdwn", async () => {
    const title = `${"a".repeat(2598)}😀tail`;
    const payload = await buildPluginPendingPayload({
      approvalId: "plugin:req-surrogate",
      title,
      description: "Needs approval.",
      severity: "warning",
      pluginId: "test-plugin",
      toolName: "test-tool",
    });

    const requestMrkdwn = findApprovalMrkdwn(payload, "*Request*");
    expect(requestMrkdwn).toMatch(/…$/);
    expect(UNPAIRED_SURROGATE_RE.test(requestMrkdwn)).toBe(false);
  });

  it("still truncates plain BMP approval mrkdwn at the Slack approval preview limit", async () => {
    const commandText = "b".repeat(2700);
    const payload = await buildExecPendingPayload({ approvalId: "req-bmp", commandText });

    const commandMrkdwn = findApprovalMrkdwn(payload, "*Command*");
    expect(commandMrkdwn).toMatch(/…\n```$/);
    expect(commandMrkdwn).toContain(`${"b".repeat(2599)}…`);
    expect(UNPAIRED_SURROGATE_RE.test(commandMrkdwn)).toBe(false);
  });

  it("renders only the allowed pending actions", async () => {
    const payload = await buildExecPendingPayload({
      approvalId: "req-1",
      commandText: "echo hi",
      decisions: ["allow-once", "deny"],
    });

    expect(payload.text).toContain("*Exec approval required*");
    expect((payload.blocks as Array<{ block_id?: string }>)[0]?.block_id).toBe(
      "openclaw_approval_header",
    );
    const actionsBlock = findSlackActionsBlock(
      payload.blocks as Array<{ type?: string; elements?: unknown[] }>,
    );
    const labels = readSlackActionLabels(actionsBlock);

    expect(labels).toEqual(["Allow Once", "Deny"]);
    expect(JSON.stringify(payload.blocks)).not.toContain("Allow Always");
    expect(JSON.stringify(payload.blocks)).not.toContain("/approve");
    expect(JSON.stringify(payload.blocks)).toContain("openclaw:approval_button");
    expect(decodeSlackApprovalElements(actionsBlock)).toEqual([
      expect.objectContaining({ approvalKind: "exec", decision: "allow-once" }),
      expect.objectContaining({ approvalKind: "exec", decision: "deny" }),
    ]);
  });

  it("renders plugin pending approvals with plugin approval actions", async () => {
    const payload = await buildPluginPendingPayload({
      ...SCREEN_SHARE_APPROVAL,
      metadata: [
        { label: "Severity", value: "Warning" },
        { label: "Plugin", value: "computer-use" },
        {
          label: "Scope",
          value: "Send to 3 recipients via email (external): alice@example.com, +2 more",
        },
      ],
      decisions: ["allow-once", "allow-always", "deny"],
    });

    expect(payload.text).toContain("*Plugin approval required*");
    expect((payload.blocks as Array<{ block_id?: string }>)[0]?.block_id).toBe(
      "openclaw_approval_header",
    );
    expect(payload.text).toContain("Share screen with Computer Use");
    expect(payload.text).toContain("*Approval ID:* plugin:req-1");
    expect(payload.text).toContain(
      "*Scope:* Send to 3 recipients via email (external): alice@example.com, +2 more",
    );
    expect(readMrkdwnTexts(payload.blocks)).toContain(
      "*Scope:* Send to 3 recipients via email (external): alice@example.com, +2 more",
    );
    expect(payload.text).not.toContain("*Command*");
    const actionsBlock = findSlackActionsBlock(
      payload.blocks as Array<{ type?: string; elements?: unknown[] }>,
    );
    const labels = readSlackActionLabels(actionsBlock);

    expect(labels).toEqual(["Allow Once", "Allow Always", "Deny"]);
    expect(JSON.stringify(payload.blocks)).toContain("plugin:req-1");
    expect(JSON.stringify(payload.blocks)).not.toContain("/approve");
    expect(decodeSlackApprovalElements(actionsBlock)).toEqual([
      expect.objectContaining({ approvalKind: "plugin", decision: "allow-once" }),
      expect.objectContaining({ approvalKind: "plugin", decision: "allow-always" }),
      expect.objectContaining({ approvalKind: "plugin", decision: "deny" }),
    ]);
  });

  it("escapes plugin approval mrkdwn triggers at the Slack render boundary", async () => {
    // The canonical approval record stays literal so non-Slack surfaces read
    // correctly, which makes escaping this renderer's responsibility.
    const payload = await buildPluginPendingPayload({
      ...SCREEN_SHARE_APPROVAL,
      title: "touch /tmp/SIDE_EFFECT && echo *done*",
      description: "Link bait <https://evil.test|click> for @channel",
    });

    const requestMrkdwn = findApprovalMrkdwn(payload, "*Request*");
    expect(requestMrkdwn).toContain("SIDE\\_EFFECT");
    expect(requestMrkdwn).toContain("&amp;&amp;");
    expect(requestMrkdwn).toContain("\\*done\\*");
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain("&lt;https://evil.test|click&gt;");
    expect(serialized).not.toContain("<https://evil.test|click>");
  });

  it("renders resolved updates without interactive blocks", async () => {
    const result = await buildExecResolvedResult();

    expect(result.kind).toBe("update");
    if (result.kind !== "update") {
      throw new Error("expected Slack resolved update payload");
    }
    const payload = result.payload as SlackPayload;
    expect(payload.text).toContain("*Exec approval: Allowed once*");
    expect(payload.text).toContain("Resolved by <@U123APPROVER>.");
    expect(
      (payload.blocks as Array<{ type?: string }>).some((block) => block.type === "actions"),
    ).toBe(false);
  });

  it("renders expired exec approvals without interactive controls", async () => {
    const result = await buildExecExpiredResult();

    expect(result).toEqual({
      kind: "update",
      payload: {
        text: "*Exec approval expired*\nThis approval request expired before it was resolved.\n\n*Command*\n```\necho hi\n```",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Exec approval expired*\nThis approval request expired before it was resolved.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Command*\n```\necho hi\n```",
            },
          },
        ],
      },
    });
  });

  it("renders plugin resolved and expired updates without command text", async () => {
    const resolved = await buildPluginResolvedResult();
    const expired = await buildPluginExpiredResult();

    expect(resolved.kind).toBe("update");
    expect(expired.kind).toBe("update");
    if (resolved.kind !== "update" || expired.kind !== "update") {
      throw new Error("expected Slack update payloads");
    }
    const resolvedPayload = resolved.payload as SlackPayload;
    const expiredPayload = expired.payload as SlackPayload;
    expect(resolvedPayload.text).toContain("*Plugin approval: Allowed once*");
    expect(resolvedPayload.text).toContain("Resolved by <@U123APPROVER>.");
    expect(resolvedPayload.text).toContain("Share screen with Computer Use");
    expect(resolvedPayload.text).not.toContain("*Command*");
    expect(expiredPayload.text).toContain("*Plugin approval expired*");
    expect(expiredPayload.text).toContain("Share screen with Computer Use");
    expect(expiredPayload.text).not.toContain("*Command*");
    expect(
      (resolvedPayload.blocks as Array<{ type?: string }>).some(
        (block) => block.type === "actions",
      ),
    ).toBe(false);
  });

  it("caps resolved update fallback text to Slack chat.update limits while preserving blocks", async () => {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Command*\n```short preview```",
        },
      },
    ];
    const chatUpdate = vi.fn(async (_payload: { text: string; blocks: typeof blocks }) => ({}));
    const context = {
      app: {
        client: {
          chat: {
            update: chatUpdate,
          },
        },
      },
      config: {},
    } as never;

    await updateSlackApprovalEntry(context, {
      text: "a".repeat(SLACK_CHAT_UPDATE_TEXT_MAX_BYTES),
      blocks,
    });

    await updateSlackApprovalEntry(context, { text: "a".repeat(5000), blocks });

    const firstUpdate = readChatUpdatePayload(chatUpdate, 0);
    const secondUpdate = readChatUpdatePayload(chatUpdate, 1);
    expect(firstUpdate.channel).toBe("C123");
    expect(firstUpdate.ts).toBe("1712345678.999999");
    expect(firstUpdate.text).toBe("a".repeat(SLACK_CHAT_UPDATE_TEXT_MAX_BYTES));
    expect(firstUpdate.blocks).toBe(blocks);
    expect(secondUpdate.channel).toBe("C123");
    expect(secondUpdate.ts).toBe("1712345678.999999");
    expect(secondUpdate.text).toMatch(/…$/);
    expect(secondUpdate.blocks).toBe(blocks);
    expect(countSlackTextUtf8Bytes(secondUpdate.text ?? "")).toBe(SLACK_CHAT_UPDATE_TEXT_MAX_BYTES);
  });

  it("keeps pending metadata context within Slack Block Kit limits", async () => {
    const payload = await buildExecPendingPayload({
      approvalId: "req-1",
      commandText: "echo hi",
      metadata: Array.from({ length: 12 }, (_entry, index) => ({
        label: `Metadata ${index + 1}`,
        value: index === 0 ? "x".repeat(3100) : `value-${index + 1}`,
      })),
    });

    const contextBlock = (payload.blocks as Array<{ type?: string; elements?: unknown[] }>).find(
      (block) => block.type === "context",
    );
    const elements = contextBlock?.elements as Array<{ text?: string }> | undefined;

    expect(elements).toHaveLength(10);
    expect(elements?.[0]?.text).toHaveLength(3000);
    expect(elements?.[0]?.text?.endsWith("…")).toBe(true);
    expect(elements?.at(-1)?.text).toBe("…+3 more");
  });
});
