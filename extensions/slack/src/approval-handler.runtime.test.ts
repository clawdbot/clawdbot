// Slack tests cover approval handler plugin behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import type {
  ApprovalActionView,
  ApprovalMetadataView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeSlackApprovalAction,
  verifySlackEnterpriseApprovalAction,
} from "./approval-actions.js";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";

const { sendMessageSlackMock, updateMessageSlackMock } = vi.hoisted(() => ({
  sendMessageSlackMock: vi.fn(),
  updateMessageSlackMock: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
  updateMessageSlack: updateMessageSlackMock,
}));

type SlackPayload = {
  text: string;
  blocks: Array<Block | KnownBlock>;
};
type SlackUpdateEntryParams = Parameters<
  NonNullable<typeof slackApprovalNativeRuntime.transport.updateEntry>
>[0];
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
    approvalSigningKey: "approval-signing-key",
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
  approvalKind: "exec" | "plugin",
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

function findSlackActionsBlock(
  blocks: readonly unknown[],
): { type?: string; elements?: unknown[] } | undefined {
  return blocks.find((block): block is { type?: string; elements?: unknown[] } =>
    Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "actions"),
  );
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

async function updateSlackApprovalEntry(
  context: SlackUpdateEntryParams["context"],
  payload: SlackUpdateEntryParams["payload"],
): Promise<void> {
  await slackApprovalNativeRuntime.transport.updateEntry?.({
    ...APPROVAL_CONTEXT,
    context,
    entry: { channelId: "C123", messageTs: "1712345678.999999", teamId: "T123" },
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
  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    updateMessageSlackMock.mockReset();
  });

  it("subscribes to plugin approval events", () => {
    expect(slackApprovalNativeRuntime.eventKinds).toEqual(["exec", "plugin"]);
  });

  it("carries a qualified target workspace into the pending approval receipt", async () => {
    const request = {
      id: "req-grid",
      request: { command: "echo hi" },
      ...APPROVAL_TIMING,
    };
    const pendingPayload = await buildExecPendingPayload({
      approvalId: "req-grid",
      commandText: "echo hi",
      decisions: ["allow-once", "deny"],
    });
    const originalActionsBlock = findSlackActionsBlock(pendingPayload.blocks);
    expect(decodeSlackApprovalElements(originalActionsBlock)).toEqual([
      expect.objectContaining({ approvalId: "req-grid", decision: "allow-once" }),
      expect.objectContaining({ approvalId: "req-grid", decision: "deny" }),
    ]);
    const prepared = await slackApprovalNativeRuntime.transport.prepareTarget({
      ...APPROVAL_CONTEXT,
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: { to: "team:T123:channel:C123", threadId: "1712345678.100000" },
      },
      request,
      approvalKind: "exec",
      view: {} as never,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("expected prepared Slack approval target");
    }
    sendMessageSlackMock.mockResolvedValueOnce({
      channelId: "C123",
      messageId: "1712345678.200000",
    });

    const entry = await slackApprovalNativeRuntime.transport.deliverPending({
      ...APPROVAL_CONTEXT,
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: { to: "team:T123:channel:C123", threadId: "1712345678.100000" },
      },
      preparedTarget: prepared.target,
      request,
      approvalKind: "exec",
      view: {} as never,
      pendingPayload,
    });

    expect(prepared.target).toEqual({
      to: "team:T123:channel:C123",
      threadTs: "1712345678.100000",
      teamId: "T123",
    });
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "team:T123:channel:C123",
      expect.stringContaining("Exec approval required"),
      expect.objectContaining({ accountId: "default", threadTs: "1712345678.100000" }),
    );
    const sendOptions = sendMessageSlackMock.mock.calls[0]?.[2] as
      | { blocks?: Array<{ type?: string; elements?: Array<{ value?: unknown }> }> }
      | undefined;
    const actionsBlock = findSlackActionsBlock(sendOptions?.blocks ?? []);
    const values = (actionsBlock?.elements ?? []).map((element) =>
      element && typeof element === "object" ? (element as { value?: unknown }).value : undefined,
    );
    expect(values).toHaveLength(2);
    expect(
      values.map((value) =>
        verifySlackEnterpriseApprovalAction({
          value,
          teamId: "T123",
          signingKey: APPROVAL_CONTEXT.context.approvalSigningKey,
        }),
      ),
    ).toEqual([
      expect.objectContaining({ approvalId: "req-grid", decision: "allow-once" }),
      expect.objectContaining({ approvalId: "req-grid", decision: "deny" }),
    ]);
    expect(decodeSlackApprovalElements(originalActionsBlock)).toEqual([
      expect.objectContaining({ approvalId: "req-grid", decision: "allow-once" }),
      expect.objectContaining({ approvalId: "req-grid", decision: "deny" }),
    ]);
    expect(
      values.every(
        (value) =>
          verifySlackEnterpriseApprovalAction({
            value,
            teamId: "T999",
            signingKey: APPROVAL_CONTEXT.context.approvalSigningKey,
          }) === null,
      ),
    ).toBe(true);
    expect(
      values.every(
        (value) =>
          verifySlackEnterpriseApprovalAction({
            value,
            teamId: "T123",
            signingKey: "wrong-key",
          }) === null,
      ),
    ).toBe(true);
    expect(entry).toEqual({
      channelId: "C123",
      messageTs: "1712345678.200000",
      teamId: "T123",
    });
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
      ],
      decisions: ["allow-once", "allow-always", "deny"],
    });

    expect(payload.text).toContain("*Plugin approval required*");
    expect(payload.text).toContain("Share screen with Computer Use");
    expect(payload.text).toContain("*Approval ID:* plugin:req-1");
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

  it("updates a delivered approval through its persisted workspace scope", async () => {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Command*\n```short preview```",
        },
      },
    ];
    const context = {
      app: {},
      config: {},
      approvalSigningKey: "approval-signing-key",
    } as never;

    await updateSlackApprovalEntry(context, { text: "Resolved", blocks });

    expect(updateMessageSlackMock).toHaveBeenCalledWith({
      cfg: APPROVAL_CONTEXT.cfg,
      accountId: "default",
      teamId: "T123",
      channelId: "C123",
      messageTs: "1712345678.999999",
      text: "Resolved",
      blocks,
    });
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
