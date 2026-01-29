import type { WebClient } from "@slack/web-api";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SlackExecApprovalConfig } from "../../config/types.slack.js";
import { GatewayClient } from "../../gateway/client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { EventFrame } from "../../gateway/protocol/index.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { logDebug, logError } from "../../logger.js";
import type { RuntimeEnv } from "../../runtime.js";

const EXEC_APPROVAL_ACTION_ID_PREFIX = "clawdbot_execapproval";
const EXEC_APPROVAL_VALUE_PREFIX = "execapproval";

export type ExecApprovalRequest = {
  id: string;
  request: {
    command: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    agentId?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
};

type PendingApproval = {
  slackMessageTs: string;
  slackChannelId: string;
  timeoutId: NodeJS.Timeout;
};

function encodeApprovalValue(approvalId: string, action: ExecApprovalDecision): string {
  return [EXEC_APPROVAL_VALUE_PREFIX, encodeURIComponent(approvalId), action].join("|");
}

export function parseApprovalValue(
  value: string | undefined,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0] !== EXEC_APPROVAL_VALUE_PREFIX) return null;
  const [, encodedId, action] = parts;
  if (!encodedId || !action) return null;
  if (action !== "allow-once" && action !== "allow-always" && action !== "deny") return null;
  try {
    return { approvalId: decodeURIComponent(encodedId), action };
  } catch {
    return null;
  }
}

export function getExecApprovalActionIdPrefix(): string {
  return EXEC_APPROVAL_ACTION_ID_PREFIX;
}

export function matchesExecApprovalActionId(actionId: string): boolean {
  return actionId.startsWith(EXEC_APPROVAL_ACTION_ID_PREFIX);
}

function formatApprovalBlocks(request: ExecApprovalRequest) {
  const commandText = request.request.command;
  const commandPreview =
    commandText.length > 2000 ? `${commandText.slice(0, 2000)}...` : commandText;
  const expiresAtUnix = Math.floor(request.expiresAtMs / 1000);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - Date.now()) / 1000));
  const fallbackTime = new Date(request.expiresAtMs).toISOString();

  const contextParts: string[] = [];
  if (request.request.cwd) contextParts.push(`*CWD:* ${request.request.cwd}`);
  if (request.request.host) contextParts.push(`*Host:* ${request.request.host}`);
  if (request.request.agentId) contextParts.push(`*Agent:* ${request.request.agentId}`);

  const blocks: Array<{
    type: string;
    text?: { type: string; text: string };
    elements?: Array<
      | { type: string; text: string } // context element (mrkdwn/plain_text)
      | {
          // button element
          type: string;
          text?: { type: string; text: string; emoji?: boolean };
          action_id?: string;
          value?: string;
          style?: string;
        }
    >;
  }> = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔒 Exec Approval Required" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`\n${commandPreview}\n\`\`\``,
      },
    },
  ];

  if (contextParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join(" | ") }],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Expires <!date^${expiresAtUnix}^{time}|${fallbackTime}> (${expiresIn}s) | ID: \`${request.id}\``,
      },
    ],
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✓ Allow once", emoji: true },
        action_id: `${EXEC_APPROVAL_ACTION_ID_PREFIX}_allow_once`,
        value: encodeApprovalValue(request.id, "allow-once"),
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✓✓ Always allow", emoji: true },
        action_id: `${EXEC_APPROVAL_ACTION_ID_PREFIX}_allow_always`,
        value: encodeApprovalValue(request.id, "allow-always"),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✗ Deny", emoji: true },
        action_id: `${EXEC_APPROVAL_ACTION_ID_PREFIX}_deny`,
        value: encodeApprovalValue(request.id, "deny"),
        style: "danger",
      },
    ],
  });

  return blocks;
}

function formatResolvedBlocks(
  request: ExecApprovalRequest,
  decision: ExecApprovalDecision,
  resolvedBy?: string | null,
) {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;

  const decisionLabel =
    decision === "allow-once"
      ? "✅ Allowed (once)"
      : decision === "allow-always"
        ? "✅ Allowed (always)"
        : "❌ Denied";

  const resolvedByText = resolvedBy ? ` by ${resolvedBy}` : "";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Exec Approval: ${decisionLabel}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`\n${commandPreview}\n\`\`\``,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Resolved${resolvedByText} | ID: \`${request.id}\`` }],
    },
  ];
}

function formatExpiredBlocks(request: ExecApprovalRequest) {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "⏱️ Exec Approval: Expired" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`\n${commandPreview}\n\`\`\``,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `ID: \`${request.id}\`` }],
    },
  ];
}

export type SlackExecApprovalHandlerOpts = {
  client: WebClient;
  accountId: string;
  config: SlackExecApprovalConfig;
  gatewayUrl?: string;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
};

export class SlackExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private requestCache = new Map<string, ExecApprovalRequest>();
  private opts: SlackExecApprovalHandlerOpts;
  private started = false;

  constructor(opts: SlackExecApprovalHandlerOpts) {
    this.opts = opts;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) return false;
    if (!config.approvers || config.approvers.length === 0) return false;

    // Check agent filter
    if (config.agentFilter?.length) {
      if (!request.request.agentId) return false;
      if (!config.agentFilter.includes(request.request.agentId)) return false;
    }

    // Check session filter (substring match)
    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) return false;
      const matches = config.sessionFilter.some((p) => {
        try {
          return session.includes(p) || new RegExp(p).test(session);
        } catch {
          return session.includes(p);
        }
      });
      if (!matches) return false;
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const config = this.opts.config;
    if (!config.enabled) {
      logDebug("slack exec approvals: disabled");
      return;
    }

    if (!config.approvers || config.approvers.length === 0) {
      logDebug("slack exec approvals: no approvers configured");
      return;
    }

    logDebug("slack exec approvals: starting handler");

    this.gatewayClient = new GatewayClient({
      url: this.opts.gatewayUrl ?? "ws://127.0.0.1:18789",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Slack Exec Approvals",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onHelloOk: () => {
        logDebug("slack exec approvals: connected to gateway");
      },
      onConnectError: (err) => {
        logError(`slack exec approvals: connect error: ${err.message}`);
      },
      onClose: (code, reason) => {
        logDebug(`slack exec approvals: gateway closed: ${code} ${reason}`);
      },
    });

    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Clear all pending timeouts
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.requestCache.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("slack exec approvals: stopped");
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      const request = evt.payload as ExecApprovalRequest;
      void this.handleApprovalRequested(request);
    } else if (evt.event === "exec.approval.resolved") {
      const resolved = evt.payload as ExecApprovalResolved;
      void this.handleApprovalResolved(resolved);
    }
  }

  private async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) return;

    logDebug(`slack exec approvals: received request ${request.id}`);

    this.requestCache.set(request.id, request);

    const client = this.opts.client;
    const blocks = formatApprovalBlocks(request);
    const approvers = this.opts.config.approvers ?? [];

    for (const approver of approvers) {
      const userId = String(approver);
      try {
        // Open DM channel
        const dmResponse = await client.conversations.open({ users: userId });
        const channelId = dmResponse.channel?.id;

        if (!channelId) {
          logError(`slack exec approvals: failed to open DM for user ${userId}`);
          continue;
        }

        // Send message with blocks
        const msgResponse = await client.chat.postMessage({
          channel: channelId,
          text: `🔒 Exec approval required for: ${request.request.command.slice(0, 100)}...`,
          blocks,
        });

        const messageTs = msgResponse.ts;
        if (!messageTs) {
          logError(`slack exec approvals: failed to send message to user ${userId}`);
          continue;
        }

        // Set up timeout
        const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
        const timeoutId = setTimeout(() => {
          void this.handleApprovalTimeout(request.id);
        }, timeoutMs);

        this.pending.set(request.id, {
          slackMessageTs: messageTs,
          slackChannelId: channelId,
          timeoutId,
        });

        logDebug(`slack exec approvals: sent approval ${request.id} to user ${userId}`);
      } catch (err) {
        logError(`slack exec approvals: failed to notify user ${userId}: ${String(err)}`);
      }
    }
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const pending = this.pending.get(resolved.id);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);

    const request = this.requestCache.get(resolved.id);
    this.requestCache.delete(resolved.id);

    if (!request) return;

    logDebug(`slack exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    await this.updateMessage(
      pending.slackChannelId,
      pending.slackMessageTs,
      formatResolvedBlocks(request, resolved.decision, resolved.resolvedBy),
    );
  }

  private async handleApprovalTimeout(approvalId: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    this.pending.delete(approvalId);

    const request = this.requestCache.get(approvalId);
    this.requestCache.delete(approvalId);

    if (!request) return;

    logDebug(`slack exec approvals: timeout for ${approvalId}`);

    await this.updateMessage(
      pending.slackChannelId,
      pending.slackMessageTs,
      formatExpiredBlocks(request),
    );
  }

  private async updateMessage(
    channelId: string,
    messageTs: string,
    blocks: ReturnType<typeof formatExpiredBlocks>,
  ): Promise<void> {
    try {
      await this.opts.client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: "Exec approval resolved",
        blocks,
      });
    } catch (err) {
      logError(`slack exec approvals: failed to update message: ${String(err)}`);
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    if (!this.gatewayClient) {
      logError("slack exec approvals: gateway client not connected");
      return false;
    }

    logDebug(`slack exec approvals: resolving ${approvalId} with ${decision}`);

    try {
      await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      logDebug(`slack exec approvals: resolved ${approvalId} successfully`);
      return true;
    } catch (err) {
      logError(`slack exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }
}
