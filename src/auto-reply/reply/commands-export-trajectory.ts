// Implements trajectory export command packaging for the active session agent.
import { createExecTool } from "../../agents/bash-tools.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ReplyPayload } from "../types.js";
import { formatCommandExecResult, formatCommandExecText } from "./command-exec-result.js";
import { parseExportCommandOutputPath } from "./commands-export-common.js";
import { buildCurrentOpenClawCliExecRequest } from "./commands-openclaw-cli.js";
import {
  buildPrivateCommandApprovalRequest,
  deliverPrivateCommandReply,
  resolveCommandExecApprovalRoute,
  resolvePrivateCommandRouteTargets,
  type PrivateCommandRouteTarget,
} from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";

const EXPORT_TRAJECTORY_DOCS_URL = "https://docs.openclaw.ai/tools/trajectory";
const EXPORT_TRAJECTORY_EXEC_SCOPE_KEY = "chat:export-trajectory";
const MAX_TRAJECTORY_EXPORT_ENCODED_REQUEST_CHARS = 8192;
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner approval route for the trajectory export. Run /export-trajectory from an owner DM so the sensitive trajectory bundle is not posted in this chat.";
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_REPLIES = {
  delivered:
    "Trajectory exports are sensitive. I sent the trajectory export details to the owner privately.",
  pending:
    "Trajectory exports are sensitive. Private delivery of the export request is pending; I can't confirm receipt yet.",
  suppressed:
    "Trajectory exports are sensitive. Private delivery of the export request was suppressed.",
  failed: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE,
};

export async function buildExportTrajectoryCommandReply(
  params: HandleCommandsParams,
): Promise<ReplyPayload> {
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
    const now = Date.now();
    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: params,
      request: buildPrivateCommandApprovalRequest({
        commandParams: params,
        id: "trajectory-export-private-route",
        command: request.command,
        commandArgv: request.argv,
        agentId: params.agentId,
        createdAtMs: now,
      }),
    });
    const privateTarget = targets[0];
    if (!privateTarget) {
      return { text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
    }
    const privateReply = await buildExportTrajectoryApprovalReply(params, request, {
      privateApprovalTarget: privateTarget,
    });
    const outcome = await deliverPrivateCommandReply({
      commandParams: params,
      targets: [privateTarget],
      reply: privateReply,
    });
    return {
      text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_REPLIES[outcome],
    };
  }
  return await buildExportTrajectoryApprovalReply(params, request);
}

async function buildExportTrajectoryApprovalReply(
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
      await requestTrajectoryExportApproval(params, request, options),
    ].join("\n"),
  };
}

async function requestTrajectoryExportApproval(
  params: HandleCommandsParams,
  request: TrajectoryExportExecRequest,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
): Promise<string> {
  const timeoutSec = params.cfg.tools?.exec?.timeoutSeconds;
  try {
    const execTool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "export-trajectory",
      scopeKey: EXPORT_TRAJECTORY_EXEC_SCOPE_KEY,
      allowBackground: true,
      approvalFollowupMode: "agent",
      timeoutSec,
      cwd: params.workspaceDir,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionEntry?.sessionId,
      sessionStore: params.cfg.session?.store,
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
    const result = await execTool.execute("chat-export-trajectory", {
      command: request.command,
      env: request.env,
      ask: "always",
      background: true,
      timeoutSeconds: timeoutSec,
    });
    return [
      `Trajectory bundle: requested \`${request.displayCommand}\` through exec approval. Approve once to create the bundle; do not use allow-all for trajectory exports.`,
      formatCommandExecResult(result, "Trajectory export"),
    ].join("\n");
  } catch (error) {
    return [
      `Trajectory bundle: could not request exec approval for \`${request.displayCommand}\`.`,
      formatCommandExecText(formatErrorMessage(error)),
    ].join("\n");
  }
}

type TrajectoryExportCliRequest = {
  sessionKey: string;
  workspace: string;
  output?: string;
  store?: string;
  agent: string;
};

type TrajectoryExportExecRequest = {
  argv: string[];
  command: string;
  env: Record<string, string> | undefined;
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
    agent: params.agentId,
  };
  if (outputPath) {
    request.output = outputPath;
  }
  if (params.storePath && params.storePath !== "(multiple)") {
    request.store = params.storePath;
  }
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  if (encodedRequest.length > MAX_TRAJECTORY_EXPORT_ENCODED_REQUEST_CHARS) {
    throw new Error("Encoded trajectory export request is too large");
  }
  const args = ["sessions", "export-trajectory", "--request-json-base64", encodedRequest, "--json"];
  return {
    ...buildCurrentOpenClawCliExecRequest(args),
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
  lines.push(`Agent: ${request.agent}`);
  return lines.join("\n");
}
