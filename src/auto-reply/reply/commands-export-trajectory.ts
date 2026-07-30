// Implements trajectory export command packaging for the active session agent.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { ExecToolDetails } from "../../agents/bash-tools.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { ReplyPayload } from "../types.js";
import { parseExportCommandOutputPath } from "./commands-export-common.js";
import {
  buildCurrentOpenClawCliArgv,
  buildCurrentOpenClawCliCommand,
  buildCurrentOpenClawCliExecEnv,
} from "./commands-openclaw-cli.js";
import {
  deliverPrivateCommandReply,
  readCommandDeliveryTarget,
  readCommandMessageThreadId,
  resolveCommandExecApprovalRoute,
  resolvePrivateCommandApprovalRouteExpiresAtMs,
  resolvePrivateCommandRouteTargets,
  type PrivateCommandRouteTarget,
} from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";

const EXPORT_TRAJECTORY_DOCS_URL = "https://docs.openclaw.ai/tools/trajectory";
const EXPORT_TRAJECTORY_EXEC_SCOPE_KEY = "chat:export-trajectory";
const MAX_TRAJECTORY_EXPORT_ENCODED_REQUEST_CHARS = 8192;
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner approval route for the trajectory export. Run /export-trajectory from an owner DM so the sensitive trajectory bundle is not posted in this chat.";
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_ACK =
  "Trajectory exports are sensitive. I sent the export request and approval prompt to the owner privately.";

type ExportTrajectoryCommandDeps = {
  createExecTool: typeof createExecTool;
  resolvePrivateTrajectoryTargets: (
    params: HandleCommandsParams,
    request: TrajectoryExportExecRequest,
  ) => Promise<PrivateCommandRouteTarget[]>;
  deliverPrivateTrajectoryReply: (params: {
    commandParams: HandleCommandsParams;
    targets: PrivateCommandRouteTarget[];
    reply: ReplyPayload;
  }) => Promise<boolean>;
};

const defaultExportTrajectoryCommandDeps: ExportTrajectoryCommandDeps = {
  createExecTool,
  resolvePrivateTrajectoryTargets: resolvePrivateTrajectoryTargetsForCommand,
  deliverPrivateTrajectoryReply,
};

export async function buildExportTrajectoryCommandReply(
  params: HandleCommandsParams,
  deps: Partial<ExportTrajectoryCommandDeps> = {},
): Promise<ReplyPayload> {
  const resolvedDeps: ExportTrajectoryCommandDeps = {
    ...defaultExportTrajectoryCommandDeps,
    ...deps,
  };
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-trajectory",
    "trajectory",
  ]);
  if (args.error) {
    return { text: args.error };
  }
  let request: TrajectoryExportExecRequest;
  try {
    request = buildTrajectoryExportExecRequest(params, args.outputPath);
  } catch (error) {
    return { text: `❌ Failed to prepare trajectory export request: ${formatErrorMessage(error)}` };
  }
  if (params.isGroup) {
    const targets = await resolvedDeps.resolvePrivateTrajectoryTargets(params, request);
    if (targets.length === 0) {
      return { text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
    }
    const privateTarget = targets[0];
    if (!privateTarget) {
      return { text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
    }
    const privateReply = await buildExportTrajectoryApprovalReply(resolvedDeps, params, request, {
      privateApprovalTarget: privateTarget,
    });
    const delivered = await resolvedDeps.deliverPrivateTrajectoryReply({
      commandParams: params,
      targets: [privateTarget],
      reply: privateReply,
    });
    return {
      text: delivered
        ? EXPORT_TRAJECTORY_PRIVATE_ROUTE_ACK
        : EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE,
    };
  }
  return await buildExportTrajectoryApprovalReply(resolvedDeps, params, request);
}

async function buildExportTrajectoryApprovalReply(
  deps: ExportTrajectoryCommandDeps,
  params: HandleCommandsParams,
  request: TrajectoryExportExecRequest,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
): Promise<ReplyPayload> {
  return {
    text: [
      "Trajectory exports can include prompts, model messages, tool schemas, tool results, runtime events, and local paths.",
      `Treat trajectory bundles like secrets and review them before sharing: ${EXPORT_TRAJECTORY_DOCS_URL}`,
      "",
      formatTrajectoryExportRequestDetails(request.request),
      "",
      await requestTrajectoryExportApproval(deps, params, request, options),
    ].join("\n"),
  };
}

async function resolvePrivateTrajectoryTargetsForCommand(
  params: HandleCommandsParams,
  request: TrajectoryExportExecRequest,
): Promise<PrivateCommandRouteTarget[]> {
  return await resolvePrivateCommandRouteTargets({
    commandParams: params,
    request: buildTrajectoryExportApprovalRequest(params, request),
  });
}

async function deliverPrivateTrajectoryReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateCommandRouteTarget[];
  reply: ReplyPayload;
}): Promise<boolean> {
  return await deliverPrivateCommandReply(params);
}

function buildTrajectoryExportApprovalRequest(
  params: HandleCommandsParams,
  request: TrajectoryExportExecRequest,
): ExecApprovalRequest {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return {
    id: "trajectory-export-private-route",
    request: {
      command: request.command,
      commandArgv: request.argv,
      agentId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      turnSourceChannel: params.command.channel,
      turnSourceTo: readCommandDeliveryTarget(params) ?? null,
      turnSourceAccountId: params.ctx.AccountId ?? null,
      turnSourceThreadId: readCommandMessageThreadId(params) ?? null,
    },
    createdAtMs: now,
    expiresAtMs: resolvePrivateCommandApprovalRouteExpiresAtMs(now),
  };
}

async function requestTrajectoryExportApproval(
  deps: ExportTrajectoryCommandDeps,
  params: HandleCommandsParams,
  request: TrajectoryExportExecRequest,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
): Promise<string> {
  const timeoutSec = params.cfg.tools?.exec?.timeoutSeconds;
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  try {
    const execTool = deps.createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "export-trajectory",
      scopeKey: EXPORT_TRAJECTORY_EXEC_SCOPE_KEY,
      allowBackground: true,
      approvalFollowupMode: "agent",
      timeoutSec,
      cwd: params.workspaceDir,
      agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionEntry?.sessionId,
      sessionStore: params.cfg.session?.store,
      mainKey: params.cfg.session?.mainKey,
      sessionScope: params.cfg.session?.scope,
      ...resolveCommandExecApprovalRoute({
        commandParams: params,
        privateApprovalTarget: options.privateApprovalTarget,
      }),
      notifyOnExit: params.cfg.tools?.exec?.notifyOnExit,
      notifyOnExitEmptySuccess: params.cfg.tools?.exec?.notifyOnExitEmptySuccess,
    });
    const result = await execTool.execute("chat-export-trajectory", {
      command: request.command,
      env: buildCurrentOpenClawCliExecEnv(),
      security: "allowlist",
      ask: "always",
      background: true,
      timeout: timeoutSec,
    });
    return [
      `Trajectory bundle: requested \`${request.displayCommand}\` through exec approval. Approve once to create the bundle; do not use allow-all for trajectory exports.`,
      formatExecToolResultForTrajectory(result),
    ].join("\n");
  } catch (error) {
    return [
      `Trajectory bundle: could not request exec approval for \`${request.displayCommand}\`.`,
      formatExecTrajectoryText(formatErrorMessage(error)),
    ].join("\n");
  }
}

function formatExecToolResultForTrajectory(result: {
  content?: Array<{ type: string; text?: string }>;
  details?: ExecToolDetails;
}): string {
  const text = result.content
    ?.map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) {
    return formatExecTrajectoryText(text);
  }
  const details = result.details;
  if (details?.status === "approval-pending") {
    const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
    return formatExecTrajectoryText(
      `Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`,
    );
  }
  if (details?.status === "running") {
    return formatExecTrajectoryText(
      `Trajectory export is running (exec session ${details.sessionId}).`,
    );
  }
  if (details?.status === "completed" || details?.status === "failed") {
    return formatExecTrajectoryText(details.aggregated);
  }
  return "(no exec details returned)";
}

function formatExecTrajectoryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(no exec output)";
  }
  return trimmed;
}

type TrajectoryExportCliRequest = {
  sessionKey: string;
  workspace: string;
  output?: string;
  store?: string;
  agent?: string;
};

type TrajectoryExportExecRequest = {
  argv: string[];
  command: string;
  displayCommand: string;
  encodedRequest: string;
  request: TrajectoryExportCliRequest;
};

function buildTrajectoryExportExecRequest(
  params: HandleCommandsParams,
  outputPath?: string,
): TrajectoryExportExecRequest {
  const request: TrajectoryExportCliRequest = {
    sessionKey: params.sessionKey,
    workspace: params.workspaceDir,
  };
  if (outputPath) {
    request.output = outputPath;
  }
  if (params.storePath && params.storePath !== "(multiple)") {
    request.store = params.storePath;
  }
  if (params.agentId) {
    request.agent = params.agentId;
  }
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  if (encodedRequest.length > MAX_TRAJECTORY_EXPORT_ENCODED_REQUEST_CHARS) {
    throw new Error("Encoded trajectory export request is too large");
  }
  const args = ["sessions", "export-trajectory", "--request-json-base64", encodedRequest, "--json"];
  return {
    argv: buildCurrentOpenClawCliArgv(args),
    command: buildCurrentOpenClawCliCommand(args),
    displayCommand: ["openclaw", ...args].join(" "),
    encodedRequest,
    request,
  };
}

function formatTrajectoryExportRequestDetails(request: TrajectoryExportCliRequest): string {
  const lines = [
    `Session: ${request.sessionKey}`,
    `Workspace: ${request.workspace}`,
    `Output: ${request.output ?? "(default)"}`,
  ];
  if (request.store) {
    lines.push(`Store: ${request.store}`);
  }
  if (request.agent) {
    lines.push(`Agent: ${request.agent}`);
  }
  return lines.join("\n");
}
