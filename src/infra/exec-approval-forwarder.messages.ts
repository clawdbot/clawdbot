import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../channels/plugins/index.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
  buildTypedApprovalPendingReplyPayload,
  buildTypedPluginApprovalPendingReplyPayload,
} from "../plugin-sdk/approval-renderers.js";
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { formatExecApprovalExpiresIn } from "./exec-approval-reply.js";
import { sanitizeExecApprovalWarningText } from "./exec-approval-text-sanitize.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "./exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import {
  approvalDecisionLabel,
  buildPluginApprovalRequestMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "./plugin-approvals.js";

function formatApprovalCommand(command: string): { inline: boolean; text: string } {
  return !command.includes("\n") && !command.includes("`")
    ? { inline: true, text: `\`${command}\`` }
    : { inline: false, text: formatFencedCodeBlock(command) };
}

function buildForwardedExecApprovalRequest(request: ExecApprovalRequest, nowMs: number) {
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
  const decisionText = allowedDecisions.join("|");
  const lines: string[] = ["🔒 Exec approval required", `ID: ${request.id}`];
  const warningText = request.request.warningText?.trim();
  if (warningText) {
    lines.push("", warningText);
  }
  const analysisWarningLines = normalizeStringEntries(
    request.request.commandAnalysis?.warningLines.map(sanitizeExecApprovalWarningText),
  ).slice(0, 5);
  if (analysisWarningLines && analysisWarningLines.length > 0) {
    lines.push("", "Command analysis:");
    for (const line of analysisWarningLines) {
      lines.push(`- ${line}`);
    }
  }
  const command = formatApprovalCommand(
    resolveExecApprovalCommandDisplay(request.request).commandText,
  );
  if (command.inline) {
    lines.push(`Command: ${command.text}`);
  } else {
    lines.push("Command:", command.text);
  }
  if (request.request.cwd) {
    lines.push(`CWD: ${request.request.cwd}`);
  }
  if (request.request.nodeId) {
    lines.push(`Node: ${request.request.nodeId}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`Env overrides: ${request.request.envKeys.join(", ")}`);
  }
  if (request.request.host) {
    lines.push(`Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  if (request.request.security) {
    lines.push(`Security: ${request.request.security}`);
  }
  if (request.request.ask) {
    lines.push(`Ask: ${request.request.ask}`);
  }
  lines.push(`Expires in: ${formatExecApprovalExpiresIn(request.expiresAtMs, nowMs)}`);
  lines.push("Mode: foreground (interactive approvals available in this chat).");
  lines.push(
    allowedDecisions.includes("allow-always")
      ? "Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off)."
      : "Background mode note: non-interactive runs cannot wait for chat approvals; the effective policy still requires per-run approval unless ask=off.",
  );
  lines.push(`Reply with: /approve ${request.id} ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  return lines.join("\n");
}

function buildForwardedExecApprovalResolved(resolved: ExecApprovalResolved) {
  const base = `✅ Exec approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

export function buildForwardedExecApprovalExpired(request: ExecApprovalRequest) {
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

function buildApprovalRenderPayload<TParams>(params: {
  target: ExecApprovalForwardTarget;
  renderParams: TParams;
  resolveRenderer: (
    adapter: ReturnType<typeof resolveChannelApprovalAdapter> | undefined,
  ) => ((params: TParams) => ReplyPayload | null) | undefined;
  buildFallback: () => ReplyPayload;
}): ReplyPayload {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  const adapterPayload = channel
    ? params.resolveRenderer(resolveChannelApprovalAdapter(getLoadedChannelPlugin(channel)))?.(
        params.renderParams,
      )
    : null;
  return adapterPayload ?? params.buildFallback();
}

export function buildForwardedExecPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: ExecApprovalForwardTarget;
  nowMs: number;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    target: params.target,
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.exec?.buildPendingPayload,
    buildFallback: () =>
      buildTypedApprovalPendingReplyPayload({
        approvalKind: "exec",
        approvalId: params.request.id,
        approvalSlug: params.request.id.slice(0, 8),
        text: buildForwardedExecApprovalRequest(params.request, params.nowMs),
        agentId: params.request.request.agentId ?? null,
        allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
        sessionKey: params.request.request.sessionKey ?? null,
      }),
  });
}

export function buildForwardedExecResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: ExecApprovalResolved;
  target: ExecApprovalForwardTarget;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    target: params.target,
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.exec?.buildResolvedPayload,
    buildFallback: () =>
      buildApprovalResolvedReplyPayload({
        approvalId: params.resolved.id,
        approvalSlug: params.resolved.id.slice(0, 8),
        text: buildForwardedExecApprovalResolved(params.resolved),
      }),
  });
}

export function buildForwardedPluginPendingPayload(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
  target: ExecApprovalForwardTarget;
  nowMs: number;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    target: params.target,
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.plugin?.buildPendingPayload,
    buildFallback: () =>
      buildTypedPluginApprovalPendingReplyPayload({
        request: params.request,
        nowMs: params.nowMs,
        text: buildPluginApprovalRequestMessage(params.request, params.nowMs),
        allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions(
          params.request.request,
        ),
      }),
  });
}

export function buildForwardedPluginResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: PluginApprovalResolved;
  target: ExecApprovalForwardTarget;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    target: params.target,
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.plugin?.buildResolvedPayload,
    buildFallback: () => buildPluginApprovalResolvedReplyPayload({ resolved: params.resolved }),
  });
}
