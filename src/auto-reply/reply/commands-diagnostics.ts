/** Handles diagnostics commands and private owner routing for sensitive diagnostics output. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  LegacyInteractiveReply,
  MessagePresentationAction,
} from "../../interactive/payload.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";
import type { PluginCommandDiagnosticsSession, PluginCommandResult } from "../../plugins/types.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import type { ReplyPayload } from "../types.js";
import { formatCommandExecResult, formatCommandExecText } from "./command-exec-result.js";
import { rejectNonOwnerCommand } from "./command-gates.js";
import { buildCurrentOpenClawCliExecRequest } from "./commands-openclaw-cli.js";
import {
  buildPrivateCommandApprovalRequest,
  deliverPrivateCommandReply,
  resolveCommandExecApprovalRoute,
  resolvePrivateCommandRouteTargets,
  type PrivateCommandRouteTarget,
} from "./commands-private-route.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const DIAGNOSTICS_COMMAND = "/diagnostics";
const CODEX_DIAGNOSTICS_COMMAND = "/codex diagnostics";
const DIAGNOSTICS_DOCS_URL = "https://docs.openclaw.ai/gateway/diagnostics";
const GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL = "openclaw gateway diagnostics export --json";
const DIAGNOSTICS_EXEC_SCOPE_KEY = "chat:diagnostics";
const DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner approval route for diagnostics. Run /diagnostics from an owner DM so the sensitive diagnostics details are not posted in this chat.";
const DIAGNOSTICS_PRIVATE_ROUTE_REPLIES = {
  delivered: "Diagnostics are sensitive. I sent the diagnostics details to the owner privately.",
  pending: "Diagnostics are sensitive. Private delivery is pending; I can't confirm receipt yet.",
  suppressed:
    "Diagnostics are sensitive. Private delivery of the diagnostics details was suppressed.",
  failed: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE,
};

type GatewayDiagnosticsApprovalResult =
  | { status: "pending" }
  | { status: "reply"; reply: ReplyPayload };

type CodexDiagnosticsApprovalIntegration = {
  approvalText?: string;
  approvalFollowup?: () => Promise<string | undefined>;
};

export const handleDiagnosticsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const args = parseDiagnosticsArgs(params.command.commandBodyNormalized);
  if (args == null) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /diagnostics from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const nonOwner = rejectNonOwnerCommand(params, DIAGNOSTICS_COMMAND);
  if (nonOwner) {
    return nonOwner;
  }
  // Inventory belongs to this authorized command, not every reply's retained
  // session view. Metadata preserves Codex target discovery without prompt snapshots.
  const commandParams = params.storePath
    ? {
        ...params,
        sessionStore: {
          ...Object.fromEntries(
            listSessionEntriesReadOnly({
              agentId: params.agentId,
              storePath: params.storePath,
              projection: "list",
            }).map(({ sessionKey, entry }) => [sessionKey, entry]),
          ),
          ...params.sessionStore,
        },
      }
    : params;
  if (isCodexDiagnosticsConfirmationAction(args)) {
    const codexResult = await executeCodexDiagnosticsAddon(commandParams, args);
    const reply = codexResult
      ? rewriteCodexDiagnosticsResult(codexResult)
      : { text: "No Codex diagnostics confirmation handler is available for this session." };
    if (commandParams.isGroup) {
      return await deliverGroupDiagnosticsReplyPrivately(commandParams, reply);
    }
    return {
      shouldContinue: false,
      reply,
    };
  }

  if (commandParams.isGroup) {
    const privateTarget = (await resolvePrivateDiagnosticsTargetsForCommand(commandParams))[0];
    if (!privateTarget) {
      return {
        shouldContinue: false,
        reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
      };
    }
    const privateReply = await buildDiagnosticsReply(commandParams, args, {
      diagnosticsPrivateRouted: true,
      privateApprovalTarget: privateTarget,
    });
    if (!privateReply) {
      return {
        shouldContinue: false,
        reply: {
          text: "Diagnostics are sensitive. Owner approval is pending on the private route.",
        },
      };
    }
    return await deliverGroupDiagnosticsReplyPrivately(commandParams, privateReply, privateTarget);
  }

  const reply = await buildDiagnosticsReply(commandParams, args);
  return reply ? { shouldContinue: false, reply } : { shouldContinue: false };
};

async function buildDiagnosticsReply(
  params: HandleCommandsParams,
  args: string,
  options: {
    diagnosticsPrivateRouted?: boolean;
    privateApprovalTarget?: PrivateCommandRouteTarget;
  } = {},
): Promise<ReplyPayload | undefined> {
  const codexDiagnostics = await buildCodexDiagnosticsApprovalIntegration(params, args, options);
  const gatewayApproval = await requestGatewayDiagnosticsExportApproval(
    params,
    options,
    codexDiagnostics,
  );
  if (gatewayApproval.status === "pending") {
    return undefined;
  }
  return gatewayApproval.reply;
}

async function deliverGroupDiagnosticsReplyPrivately(
  params: HandleCommandsParams,
  reply: ReplyPayload,
  privateTarget?: PrivateCommandRouteTarget,
) {
  const target = privateTarget ?? (await resolvePrivateDiagnosticsTargetsForCommand(params))[0];
  if (!target) {
    return {
      shouldContinue: false,
      reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
    };
  }
  const outcome = await deliverPrivateCommandReply({
    commandParams: params,
    targets: [target],
    reply,
  });
  return {
    shouldContinue: false,
    reply: {
      text: DIAGNOSTICS_PRIVATE_ROUTE_REPLIES[outcome],
    },
  };
}

function parseDiagnosticsArgs(commandBody: string): string | undefined {
  const trimmed = commandBody.trim();
  if (trimmed === DIAGNOSTICS_COMMAND) {
    return "";
  }
  if (trimmed.startsWith(`${DIAGNOSTICS_COMMAND} `)) {
    return trimmed.slice(DIAGNOSTICS_COMMAND.length + 1).trim();
  }
  if (trimmed.startsWith(`${DIAGNOSTICS_COMMAND}:`)) {
    return trimmed.slice(DIAGNOSTICS_COMMAND.length + 1).trim();
  }
  return undefined;
}

function buildDiagnosticsPreamble(): string[] {
  return [
    "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    `Treat diagnostics bundles like secrets and review what they contain before sharing: ${DIAGNOSTICS_DOCS_URL}`,
  ];
}

function buildDiagnosticsApprovalWarning(codexApprovalText?: string): string {
  const lines = buildDiagnosticsPreamble();
  if (codexApprovalText) {
    lines.push("", codexApprovalText);
  }
  return lines.join("\n");
}

async function resolvePrivateDiagnosticsTargetsForCommand(
  params: HandleCommandsParams,
): Promise<PrivateCommandRouteTarget[]> {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return await resolvePrivateCommandRouteTargets({
    commandParams: params,
    request: buildPrivateCommandApprovalRequest({
      commandParams: params,
      id: "diagnostics-private-route",
      command: buildGatewayDiagnosticsExportJsonRequest().command,
      agentId,
      createdAtMs: now,
    }),
  });
}

function buildGatewayDiagnosticsExportJsonRequest() {
  return buildCurrentOpenClawCliExecRequest(["gateway", "diagnostics", "export", "--json"]);
}

async function requestGatewayDiagnosticsExportApproval(
  params: HandleCommandsParams,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
  codexDiagnostics: CodexDiagnosticsApprovalIntegration = {},
): Promise<GatewayDiagnosticsApprovalResult> {
  const timeoutSec = params.cfg.tools?.exec?.timeoutSeconds;
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const { command, env } = buildGatewayDiagnosticsExportJsonRequest();
  try {
    const execTool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "diagnostics",
      scopeKey: DIAGNOSTICS_EXEC_SCOPE_KEY,
      approvalWarningText: buildDiagnosticsApprovalWarning(codexDiagnostics.approvalText),
      approvalFollowup: codexDiagnostics.approvalFollowup,
      approvalFollowupMode: "direct",
      allowBackground: true,
      timeoutSec,
      cwd: params.workspaceDir,
      agentId,
      sessionKey: params.sessionKey,
      eventRouting: {
        mainKey: params.cfg.session?.mainKey,
        sessionScope: params.cfg.session?.scope,
      },
      ...resolveCommandExecApprovalRoute({
        commandParams: params,
        privateApprovalTarget: options.privateApprovalTarget,
      }),
      notifyOnExit: params.cfg.tools?.exec?.notifyOnExit,
      notifyOnExitEmptySuccess: params.cfg.tools?.exec?.notifyOnExitEmptySuccess,
    });
    const result = await execTool.execute("chat-diagnostics-gateway-export", {
      command,
      env,
      ask: "always",
      background: true,
      timeoutSeconds: timeoutSec,
    });
    if (result.details?.status === "approval-pending") {
      return { status: "pending" };
    }
    const codexFollowupText =
      result.details?.status === "completed" || result.details?.status === "failed"
        ? await codexDiagnostics.approvalFollowup?.()
        : undefined;
    const lines = buildDiagnosticsPreamble();
    lines.push(
      "",
      `Local Gateway bundle: requested \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL}\` through exec approval. Approve once to create the bundle; do not use allow-all for diagnostics.`,
      formatCommandExecResult(result, "Gateway diagnostics export"),
    );
    if (codexFollowupText) {
      lines.push("", codexFollowupText);
    }
    return { status: "reply", reply: { text: lines.join("\n") } };
  } catch (error) {
    const lines = buildDiagnosticsPreamble();
    lines.push(
      "",
      `Local Gateway bundle: could not request exec approval for \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL}\`.`,
      formatCommandExecText(formatErrorMessage(error)),
    );
    return { status: "reply", reply: { text: lines.join("\n") } };
  }
}

async function buildCodexDiagnosticsApprovalIntegration(
  params: HandleCommandsParams,
  args: string,
  options: { diagnosticsPrivateRouted?: boolean } = {},
): Promise<CodexDiagnosticsApprovalIntegration | undefined> {
  const hasHarnessMetadata = hasCodexHarnessMetadata(params);
  const previewResult = await executeCodexDiagnosticsAddon(params, args, {
    ...options,
    diagnosticsPreviewOnly: true,
  });
  if (!previewResult) {
    return hasHarnessMetadata
      ? {
          approvalText:
            "OpenAI Codex harness: selected for this session, but the bundled Codex diagnostics command is not registered.",
        }
      : undefined;
  }
  const preview = rewriteCodexDiagnosticsResult(previewResult);
  if (!hasHarnessMetadata && isCodexDiagnosticsUnavailableText(preview.text)) {
    return undefined;
  }
  return {
    approvalText: preview.text ? ["OpenAI Codex harness:", preview.text].join("\n") : undefined,
    approvalFollowup: async () => {
      const uploadResult = await executeCodexDiagnosticsAddon(params, args, {
        ...options,
        diagnosticsUploadApproved: true,
      });
      if (!uploadResult) {
        return hasHarnessMetadata
          ? "OpenAI Codex harness: selected for this session, but the bundled Codex diagnostics command is not registered."
          : undefined;
      }
      const uploaded = rewriteCodexDiagnosticsResult(uploadResult);
      if (!hasHarnessMetadata && isCodexDiagnosticsUnavailableText(uploaded.text)) {
        return undefined;
      }
      return uploaded.text ? ["OpenAI Codex harness:", uploaded.text].join("\n") : undefined;
    },
  };
}

function isCodexDiagnosticsConfirmationAction(args: string): boolean {
  const [action, token] = args.trim().split(/\s+/, 2);
  const normalized = action?.toLowerCase();
  return Boolean(
    token &&
    (normalized === "confirm" ||
      normalized === "--confirm" ||
      normalized === "cancel" ||
      normalized === "--cancel"),
  );
}

function hasCodexHarnessMetadata(params: HandleCommandsParams): boolean {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (targetSessionEntry?.agentHarnessId === "codex") {
    return true;
  }
  return Object.values(params.sessionStore ?? {}).some(
    (entry) => entry?.agentHarnessId === "codex",
  );
}

function isCodexDiagnosticsUnavailableText(text: string | undefined): boolean {
  return (
    text?.startsWith("No Codex thread is attached to this OpenClaw session yet.") === true ||
    text?.startsWith(
      "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.",
    ) === true
  );
}

async function executeCodexDiagnosticsAddon(
  params: HandleCommandsParams,
  args: string,
  options: {
    diagnosticsPrivateRouted?: boolean;
    diagnosticsUploadApproved?: boolean;
    diagnosticsPreviewOnly?: boolean;
  } = {},
): Promise<PluginCommandResult | undefined> {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const commandBody = args ? `${CODEX_DIAGNOSTICS_COMMAND} ${args}` : CODEX_DIAGNOSTICS_COMMAND;
  const match = matchPluginCommand(commandBody);
  if (!match || match.command.pluginId !== "codex") {
    return undefined;
  }
  return await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: params.command.senderId,
    channel: params.command.channel,
    channelId: params.command.channelId,
    isAuthorizedSender: params.command.isAuthorizedSender,
    senderIsOwner: params.command.senderIsOwner,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    sessionFile: targetSessionEntry ? params.sessionKey : undefined,
    authProfileId: targetSessionEntry?.authProfileOverride,
    commandBody,
    config: params.cfg,
    from: params.command.from,
    to: params.command.to,
    originatingTo: normalizeOptionalString(params.ctx.OriginatingTo),
    accountId: params.ctx.AccountId ?? undefined,
    messageThreadId:
      typeof params.ctx.MessageThreadId === "string" ||
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : undefined,
    threadParentId: normalizeOptionalString(params.ctx.ThreadParentId),
    diagnosticsSessions: buildCodexDiagnosticsSessions(params),
    ...(options.diagnosticsUploadApproved === undefined
      ? {}
      : { diagnosticsUploadApproved: options.diagnosticsUploadApproved }),
    ...(options.diagnosticsPreviewOnly === undefined
      ? {}
      : { diagnosticsPreviewOnly: options.diagnosticsPreviewOnly }),
    ...(options.diagnosticsPrivateRouted === undefined
      ? {}
      : { diagnosticsPrivateRouted: options.diagnosticsPrivateRouted }),
  });
}

function buildCodexDiagnosticsSessions(
  params: HandleCommandsParams,
): PluginCommandDiagnosticsSession[] {
  const sessions = new Map<string, SessionEntry>();
  const activeEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (activeEntry) {
    sessions.set(params.sessionKey, activeEntry);
  }
  for (const [sessionKey, entry] of Object.entries(params.sessionStore ?? {})) {
    if (entry) {
      sessions.set(sessionKey, entry);
    }
  }
  return Array.from(sessions.entries())
    .filter(([, entry]) => Boolean(entry.sessionId?.trim()))
    .map(([sessionKey, entry]) => ({
      sessionKey,
      sessionId: entry.sessionId,
      sessionFile: sessionKey,
      agentHarnessId: entry.agentHarnessId,
      channel: resolveDiagnosticsSessionChannel(entry, params, sessionKey),
      channelId: resolveDiagnosticsSessionChannelId(entry, params, sessionKey),
      accountId:
        normalizeOptionalString(deliveryContextFromSession(entry)?.accountId) ??
        normalizeOptionalString(sessionDeliveryOrigin(entry)?.accountId) ??
        (sessionKey === params.sessionKey ? (params.ctx.AccountId ?? undefined) : undefined),
      messageThreadId:
        deliveryContextFromSession(entry)?.threadId ??
        sessionDeliveryOrigin(entry)?.threadId ??
        (sessionKey === params.sessionKey &&
        (typeof params.ctx.MessageThreadId === "string" ||
          typeof params.ctx.MessageThreadId === "number")
          ? params.ctx.MessageThreadId
          : undefined),
      threadParentId:
        sessionKey === params.sessionKey
          ? normalizeOptionalString(params.ctx.ThreadParentId)
          : undefined,
    }));
}

function resolveDiagnosticsSessionChannel(
  entry: SessionEntry,
  params: HandleCommandsParams,
  sessionKey: string,
): string | undefined {
  return (
    normalizeOptionalString(deliveryContextFromSession(entry)?.channel) ??
    normalizeOptionalString(sessionDeliveryOrigin(entry)?.provider) ??
    (sessionKey === params.sessionKey ? params.command.channel : undefined)
  );
}

function resolveDiagnosticsSessionChannelId(
  entry: SessionEntry,
  params: HandleCommandsParams,
  sessionKey: string,
) {
  return (
    normalizeOptionalString(sessionDeliveryOrigin(entry)?.nativeChannelId) ??
    (sessionKey === params.sessionKey ? params.command.channelId : undefined)
  );
}

function rewriteCodexDiagnosticsResult(result: PluginCommandResult): PluginCommandResult {
  const { continueAgent: _continueAgent, ...reply } = result;
  void _continueAgent;
  return {
    ...reply,
    ...(reply.text ? { text: rewriteCodexDiagnosticsCommandPrefix(reply.text) } : {}),
    ...(reply.interactive ? { interactive: rewriteInteractive(reply.interactive) } : {}),
  };
}

function rewriteInteractive(interactive: LegacyInteractiveReply): LegacyInteractiveReply {
  return {
    blocks: interactive.blocks.map((block) => {
      if (block.type === "buttons") {
        return {
          ...block,
          buttons: block.buttons.map((button) => ({
            ...button,
            ...(button.action ? { action: rewritePresentationAction(button.action) } : {}),
            ...(button.value ? { value: rewriteCodexDiagnosticsCommandPrefix(button.value) } : {}),
          })),
        };
      }
      if (block.type === "select") {
        return {
          ...block,
          options: block.options.map((option) => ({
            ...option,
            ...(option.action ? { action: rewritePresentationAction(option.action) } : {}),
            ...(option.value ? { value: rewriteCodexDiagnosticsCommandPrefix(option.value) } : {}),
          })),
        };
      }
      return block;
    }),
  };
}

function rewritePresentationAction(
  action: Extract<MessagePresentationAction, { type: "command" | "callback" | "model-picker" }>,
): Extract<MessagePresentationAction, { type: "command" | "callback" | "model-picker" }>;
function rewritePresentationAction(action: MessagePresentationAction): MessagePresentationAction;
function rewritePresentationAction(action: MessagePresentationAction): MessagePresentationAction {
  if (action.type === "command") {
    return {
      type: "command",
      command: rewriteCodexDiagnosticsCommandPrefix(action.command),
    };
  }
  if (action.type === "callback") {
    return {
      type: "callback",
      value: rewriteCodexDiagnosticsCommandPrefix(action.value),
    };
  }
  return action;
}

function rewriteCodexDiagnosticsCommandPrefix(value: string): string {
  return value
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} confirm`, `${DIAGNOSTICS_COMMAND} confirm`)
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} cancel`, `${DIAGNOSTICS_COMMAND} cancel`);
}
