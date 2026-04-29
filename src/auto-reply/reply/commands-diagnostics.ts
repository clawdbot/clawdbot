import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { ExecToolDetails } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { InteractiveReply } from "../../interactive/payload.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";
import type { PluginCommandDiagnosticsSession, PluginCommandResult } from "../../plugins/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";
import { rejectNonOwnerCommand } from "./command-gates.js";
import { buildCurrentOpenClawCliCommand } from "./commands-openclaw-cli.js";
import {
  deliverPrivateCommandReply,
  readCommandDeliveryTarget,
  readCommandMessageThreadId,
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
const DIAGNOSTICS_PRIVATE_ROUTE_ACK =
  "Diagnostics are sensitive. I sent the diagnostics details and approval prompts to the owner privately.";

type DiagnosticsCommandDeps = {
  createExecTool: typeof createExecTool;
  resolvePrivateDiagnosticsTargets: (
    params: HandleCommandsParams,
  ) => Promise<PrivateCommandRouteTarget[]>;
  deliverPrivateDiagnosticsReply: (params: {
    commandParams: HandleCommandsParams;
    targets: PrivateCommandRouteTarget[];
    reply: ReplyPayload;
  }) => Promise<boolean>;
};

type GatewayDiagnosticsApprovalResult =
  | { status: "pending" }
  | { status: "reply"; reply: ReplyPayload };

type CodexDiagnosticsApprovalIntegration = {
  approvalText?: string;
  approvalFollowup?: () => Promise<string | undefined>;
};

const defaultDiagnosticsCommandDeps: DiagnosticsCommandDeps = {
  createExecTool,
  resolvePrivateDiagnosticsTargets: resolvePrivateDiagnosticsTargetsForCommand,
  deliverPrivateDiagnosticsReply: deliverPrivateDiagnosticsReply,
};

export function createDiagnosticsCommandHandler(
  deps: Partial<DiagnosticsCommandDeps> = {},
): CommandHandler {
  const resolvedDeps: DiagnosticsCommandDeps = {
    ...defaultDiagnosticsCommandDeps,
    ...deps,
  };
  return async (params, allowTextCommands) =>
    await handleDiagnosticsCommandWithDeps(resolvedDeps, params, allowTextCommands);
}

export const handleDiagnosticsCommand: CommandHandler = createDiagnosticsCommandHandler();

async function handleDiagnosticsCommandWithDeps(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  allowTextCommands: boolean,
) {
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
  const ownerGate = rejectNonOwnerCommand(params, DIAGNOSTICS_COMMAND);
  if (ownerGate) {
    return ownerGate;
  }

  if (isCodexDiagnosticsConfirmationAction(args)) {
    const codexResult = await executeCodexDiagnosticsAddon(params, args);
    const reply = codexResult
      ? rewriteCodexDiagnosticsResult(codexResult)
      : { text: "No Codex diagnostics confirmation handler is available for this session." };
    if (params.isGroup) {
      return await deliverGroupDiagnosticsReplyPrivately(deps, params, reply);
    }
    return {
      shouldContinue: false,
      reply,
    };
  }

  if (params.isGroup) {
    const targets = await deps.resolvePrivateDiagnosticsTargets(params);
    if (targets.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
      };
    }
    const privateTarget = targets[0];
    if (!privateTarget) {
      return {
        shouldContinue: false,
        reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
      };
    }
    const privateReply = await buildDiagnosticsReply(deps, params, args, {
      diagnosticsPrivateRouted: true,
      privateApprovalTarget: privateTarget,
    });
    if (!privateReply) {
      return {
        shouldContinue: false,
        reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_ACK },
      };
    }
    const delivered = await deps.deliverPrivateDiagnosticsReply({
      commandParams: params,
      targets: [privateTarget],
      reply: privateReply,
    });
    return {
      shouldContinue: false,
      reply: {
        text: delivered ? DIAGNOSTICS_PRIVATE_ROUTE_ACK : DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE,
      },
    };
  }

  const reply = await buildDiagnosticsReply(deps, params, args);
  return reply ? { shouldContinue: false, reply } : { shouldContinue: false };
}

async function buildDiagnosticsReply(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  args: string,
  options: {
    diagnosticsPrivateRouted?: boolean;
    privateApprovalTarget?: PrivateCommandRouteTarget;
  } = {},
): Promise<ReplyPayload | undefined> {
  const codexDiagnostics = await buildCodexDiagnosticsApprovalIntegration(params, args, options);
  const gatewayApproval = await requestGatewayDiagnosticsExportApproval(
    deps,
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
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  reply: ReplyPayload,
) {
  const targets = await deps.resolvePrivateDiagnosticsTargets(params);
  if (targets.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
    };
  }
  const privateTarget = targets[0];
  if (!privateTarget) {
    return {
      shouldContinue: false,
      reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
    };
  }
  const delivered = await deps.deliverPrivateDiagnosticsReply({
    commandParams: params,
    targets: [privateTarget],
    reply,
  });
  return {
    shouldContinue: false,
    reply: {
      text: delivered ? DIAGNOSTICS_PRIVATE_ROUTE_ACK : DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE,
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
  return await resolvePrivateCommandRouteTargets({
    commandParams: params,
    request: buildDiagnosticsApprovalRequest(params),
  });
}

function buildDiagnosticsApprovalRequest(params: HandleCommandsParams): ExecApprovalRequest {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return {
    id: "diagnostics-private-route",
    request: {
      command: buildGatewayDiagnosticsExportJsonCommand(),
      agentId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      turnSourceChannel: params.command.channel,
      turnSourceTo: readCommandDeliveryTarget(params) ?? null,
      turnSourceAccountId: params.ctx.AccountId ?? null,
      turnSourceThreadId: readCommandMessageThreadId(params) ?? null,
    },
    createdAtMs: now,
    expiresAtMs: now + 5 * 60_000,
  };
}

function buildGatewayDiagnosticsExportJsonCommand(): string {
  return buildCurrentOpenClawCliCommand(["gateway", "diagnostics", "export", "--json"]);
}

async function deliverPrivateDiagnosticsReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateCommandRouteTarget[];
  reply: ReplyPayload;
}): Promise<boolean> {
  return await deliverPrivateCommandReply(params);
}

async function requestGatewayDiagnosticsExportApproval(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
  codexDiagnostics: CodexDiagnosticsApprovalIntegration = {},
): Promise<GatewayDiagnosticsApprovalResult> {
  const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const messageThreadId = readCommandMessageThreadId(params);
  const command = buildGatewayDiagnosticsExportJsonCommand();
  try {
    const execTool = deps.createExecTool({
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
      messageProvider: options.privateApprovalTarget?.channel ?? params.command.channel,
      currentChannelId: options.privateApprovalTarget?.to ?? readCommandDeliveryTarget(params),
      currentThreadTs: options.privateApprovalTarget
        ? options.privateApprovalTarget.threadId == null
          ? undefined
          : String(options.privateApprovalTarget.threadId)
        : messageThreadId,
      accountId: options.privateApprovalTarget
        ? (options.privateApprovalTarget.accountId ?? undefined)
        : (params.ctx.AccountId ?? undefined),
      notifyOnExit: params.cfg.tools?.exec?.notifyOnExit,
      notifyOnExitEmptySuccess: params.cfg.tools?.exec?.notifyOnExitEmptySuccess,
    });
    const result = await execTool.execute("chat-diagnostics-gateway-export", {
      command,
      security: "allowlist",
      ask: "always",
      background: true,
      timeout: timeoutSec,
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
      formatExecToolResultForDiagnostics(result),
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
      formatExecDiagnosticsText(formatErrorMessage(error)),
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
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    sessionFile: targetSessionEntry?.sessionFile,
    commandBody,
    config: params.cfg,
    from: params.command.from,
    to: params.command.to,
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
    .filter(([, entry]) => Boolean(entry.sessionFile))
    .map(([sessionKey, entry]) => ({
      sessionKey,
      sessionId: entry.sessionId,
      sessionFile: entry.sessionFile,
      agentHarnessId: entry.agentHarnessId,
      channel: resolveDiagnosticsSessionChannel(entry, params, sessionKey),
      channelId: resolveDiagnosticsSessionChannelId(entry, params, sessionKey),
      accountId:
        normalizeOptionalString(entry.deliveryContext?.accountId) ??
        normalizeOptionalString(entry.origin?.accountId) ??
        normalizeOptionalString(entry.lastAccountId) ??
        (sessionKey === params.sessionKey ? (params.ctx.AccountId ?? undefined) : undefined),
      messageThreadId:
        entry.deliveryContext?.threadId ??
        entry.origin?.threadId ??
        entry.lastThreadId ??
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
    normalizeOptionalString(entry.deliveryContext?.channel) ??
    normalizeOptionalString(entry.origin?.provider) ??
    normalizeOptionalString(entry.channel) ??
    normalizeOptionalString(entry.lastChannel) ??
    (sessionKey === params.sessionKey ? params.command.channel : undefined)
  );
}

function resolveDiagnosticsSessionChannelId(
  entry: SessionEntry,
  params: HandleCommandsParams,
  sessionKey: string,
) {
  return (
    normalizeOptionalString(entry.origin?.nativeChannelId) ??
    (sessionKey === params.sessionKey ? params.command.channelId : undefined)
  );
}

function formatExecToolResultForDiagnostics(result: {
  content?: Array<{ type: string; text?: string }>;
  details?: ExecToolDetails;
}): string {
  const text = result.content
    ?.map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) {
    return formatExecDiagnosticsText(text);
  }
  const details = result.details;
  if (details?.status === "approval-pending") {
    const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
    return formatExecDiagnosticsText(
      `Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`,
    );
  }
  if (details?.status === "running") {
    return formatExecDiagnosticsText(
      `Gateway diagnostics export is running (exec session ${details.sessionId}).`,
    );
  }
  if (details?.status === "completed" || details?.status === "failed") {
    return formatExecDiagnosticsText(details.aggregated);
  }
  return "(no exec details returned)";
}

function formatExecDiagnosticsText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(no exec output)";
  }
  return trimmed;
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

function rewriteInteractive(interactive: InteractiveReply): InteractiveReply {
  return {
    blocks: interactive.blocks.map((block) => {
      if (block.type === "buttons") {
        return {
          ...block,
          buttons: block.buttons.map((button) => ({
            ...button,
            ...(button.value ? { value: rewriteCodexDiagnosticsCommandPrefix(button.value) } : {}),
          })),
        };
      }
      if (block.type === "select") {
        return {
          ...block,
          options: block.options.map((option) => ({
            ...option,
            value: rewriteCodexDiagnosticsCommandPrefix(option.value),
          })),
        };
      }
      return block;
    }),
  };
}

function rewriteCodexDiagnosticsCommandPrefix(value: string): string {
  return value
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} confirm`, `${DIAGNOSTICS_COMMAND} confirm`)
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} cancel`, `${DIAGNOSTICS_COMMAND} cancel`);
}
