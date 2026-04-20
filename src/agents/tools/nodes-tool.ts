import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { readConnectPairingRequiredMessage } from "../../gateway/protocol/connect-error-details.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveNodePairApprovalScopes } from "../../infra/node-pairing-authz.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { executeNodeCommandAction, type NodeCommandAction } from "./nodes-tool-commands.js";
import { executeNodeMediaAction, MEDIA_INVOKE_ACTIONS } from "./nodes-tool-media.js";
import { resolveNodeId } from "./nodes-utils.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";

const NODES_TOOL_ACTIONS = [
  "status",
  "describe",
  "pending",
  "approve",
  "reject",
  "notify",
  "camera_snap",
  "camera_list",
  "camera_clip",
  "photos_latest",
  "screen_record",
  "location_get",
  "notifications_list",
  "notifications_action",
  "device_status",
  "device_info",
  "device_permissions",
  "device_health",
  "invoke",
] as const;

const NOTIFY_PRIORITIES = ["passive", "active", "timeSensitive"] as const;
const NOTIFY_DELIVERIES = ["system", "overlay", "auto"] as const;
const NOTIFICATIONS_ACTIONS = ["open", "dismiss", "reply"] as const;
const CAMERA_FACING = ["front", "back", "both"] as const;
const LOCATION_ACCURACY = ["coarse", "balanced", "precise"] as const;
type GatewayCallOptions = ReturnType<typeof readGatewayCallOptions>;

function resolveApproveScopes(commands: unknown): OperatorScope[] {
  return resolveNodePairApprovalScopes(commands) as OperatorScope[];
}

async function resolveNodePairApproveScopes(
  gatewayOpts: GatewayCallOptions,
  requestId: string,
): Promise<OperatorScope[]> {
  const pairing: {
    pending?: Array<{
      requestId?: string;
      commands?: unknown;
      requiredApproveScopes?: unknown;
    }>;
  } = await callGatewayTool("node.pair.list", gatewayOpts, {}, { scopes: ["operator.pairing"] });
  const pending = Array.isArray(pairing?.pending) ? pairing.pending : [];
  const match = pending.find((entry) => entry?.requestId === requestId);
  if (Array.isArray(match?.requiredApproveScopes)) {
    const scopes = match.requiredApproveScopes.filter(
      (scope): scope is OperatorScope =>
        scope === "operator.pairing" || scope === "operator.write" || scope === "operator.admin",
    );
    if (scopes.length > 0) {
      return scopes;
    }
  }
  return resolveApproveScopes(match?.commands);
}

// Flattened schema: runtime validates per-action requirements.
const NodesToolSchema = Type.Object({
  action: stringEnum(NODES_TOOL_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()),
  // notify
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  sound: Type.Optional(Type.String()),
  priority: optionalStringEnum(NOTIFY_PRIORITIES),
  delivery: optionalStringEnum(NOTIFY_DELIVERIES),
  // camera_snap / camera_clip
  facing: optionalStringEnum(CAMERA_FACING, {
    description: "camera_snap: front/back/both; camera_clip: front/back only.",
  }),
  maxWidth: Type.Optional(Type.Number()),
  quality: Type.Optional(Type.Number()),
  delayMs: Type.Optional(Type.Number()),
  deviceId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  duration: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number({ maximum: 300_000 })),
  includeAudio: Type.Optional(Type.Boolean()),
  // screen_record
  fps: Type.Optional(Type.Number()),
  screenIndex: Type.Optional(Type.Number()),
  outPath: Type.Optional(Type.String()),
  // location_get
  maxAgeMs: Type.Optional(Type.Number()),
  locationTimeoutMs: Type.Optional(Type.Number()),
  desiredAccuracy: optionalStringEnum(LOCATION_ACCURACY),
  // notifications_action
  notificationAction: optionalStringEnum(NOTIFICATIONS_ACTIONS),
  notificationKey: Type.Optional(Type.String()),
  notificationReplyText: Type.Optional(Type.String()),
  // invoke
  invokeCommand: Type.Optional(Type.String()),
  invokeParamsJson: Type.Optional(Type.String()),
  invokeTimeoutMs: Type.Optional(Type.Number()),
});

export function createNodesTool(options?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string | number;
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  allowMediaInvokeCommands?: boolean;
}): AnyAgentTool {
  const agentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: options?.config,
  });
  const imageSanitization = resolveImageSanitizationLimits(options?.config);
  return {
    label: "Nodes",
    name: "nodes",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("nodes"),
    description:
      "Discover and control paired nodes (status/describe/pairing/notify/camera/photos/screen/location/notifications/invoke).",
    parameters: NodesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      try {
        switch (action) {
          case "status":
            return jsonResult(await callGatewayTool("node.list", gatewayOpts, {}));
          case "describe": {
            const node = readStringParam(params, "node", { required: true });
            const nodeId = await resolveNodeId(gatewayOpts, node);
            return jsonResult(await callGatewayTool("node.describe", gatewayOpts, { nodeId }));
          }
          case "pending":
            return jsonResult(await callGatewayTool("node.pair.list", gatewayOpts, {}));
          case "approve": {
            const requestId = readStringParam(params, "requestId", {
              required: true,
            });
            const scopes = await resolveNodePairApproveScopes(gatewayOpts, requestId);
            return jsonResult(
              await callGatewayTool(
                "node.pair.approve",
                gatewayOpts,
                {
                  requestId,
                },
                { scopes },
              ),
            );
          }
          case "reject": {
            const requestId = readStringParam(params, "requestId", {
              required: true,
            });
            return jsonResult(
              await callGatewayTool("node.pair.reject", gatewayOpts, {
                requestId,
              }),
            );
          }
          case "notify": {
            const node = readStringParam(params, "node", { required: true });
            const title = typeof params.title === "string" ? params.title : "";
            const body = typeof params.body === "string" ? params.body : "";
            if (!title.trim() && !body.trim()) {
              throw new Error("title or body required");
            }
            const nodeId = await resolveNodeId(gatewayOpts, node);
            await callGatewayTool("node.invoke", gatewayOpts, {
              nodeId,
              command: "system.notify",
              params: {
                title: title.trim() || undefined,
                body: body.trim() || undefined,
                sound: typeof params.sound === "string" ? params.sound : undefined,
                priority: typeof params.priority === "string" ? params.priority : undefined,
                delivery: typeof params.delivery === "string" ? params.delivery : undefined,
              },
              idempotencyKey: crypto.randomUUID(),
            });
            return jsonResult({ ok: true });
          }
          case "camera_snap": {
            return await executeNodeMediaAction({
              action,
              params,
              gatewayOpts,
              modelHasVision: options?.modelHasVision,
              imageSanitization,
            });
          }
          case "photos_latest": {
            return await executeNodeMediaAction({
              action,
              params,
              gatewayOpts,
              modelHasVision: options?.modelHasVision,
              imageSanitization,
            });
          }
          case "camera_list":
          case "notifications_list":
          case "device_status":
          case "device_info":
          case "device_permissions":
          case "device_health": {
            return await executeNodeCommandAction({
              action: action as NodeCommandAction,
              input: params,
              gatewayOpts,
              allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
              mediaInvokeActions: MEDIA_INVOKE_ACTIONS,
            });
          }
          case "notifications_action": {
            return await executeNodeCommandAction({
              action,
              input: params,
              gatewayOpts,
              allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
              mediaInvokeActions: MEDIA_INVOKE_ACTIONS,
            });
          }
          case "camera_clip": {
            return await executeNodeMediaAction({
              action,
              params,
              gatewayOpts,
              modelHasVision: options?.modelHasVision,
              imageSanitization,
            });
          }
          case "screen_record": {
            return await executeNodeMediaAction({
              action,
              params,
              gatewayOpts,
              modelHasVision: options?.modelHasVision,
              imageSanitization,
            });
          }
          case "location_get": {
            return await executeNodeCommandAction({
              action,
              input: params,
              gatewayOpts,
              allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
              mediaInvokeActions: MEDIA_INVOKE_ACTIONS,
            });
          }
          case "invoke": {
            return await executeNodeCommandAction({
              action,
              input: params,
              gatewayOpts,
              allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
              mediaInvokeActions: MEDIA_INVOKE_ACTIONS,
            });
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (err) {
        const nodeLabel =
          typeof params.node === "string" && params.node.trim() ? params.node.trim() : "auto";
        const gatewayLabel =
          gatewayOpts.gatewayUrl && gatewayOpts.gatewayUrl.trim()
            ? gatewayOpts.gatewayUrl.trim()
            : "default";
        const agentLabel = agentId ?? "unknown";
        let message = formatErrorMessage(err);
        const pairing = action === "invoke" ? readConnectPairingRequiredMessage(message) : null;
        if (pairing) {
          const requestId = pairing.requestId ?? null;
          const approveHint = requestId
            ? `Approve pairing request ${requestId} and retry.`
            : "Approve the pending pairing request and retry.";
          message = `pairing required before node invoke. ${approveHint}`;
        }
        throw new Error(
          `agent=${agentLabel} node=${nodeLabel} gateway=${gatewayLabel} action=${action}: ${message}`,
          { cause: err },
        );
      }
    },
  };
}
