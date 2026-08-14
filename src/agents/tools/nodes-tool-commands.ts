/**
 * Nodes command action executor.
 *
 * Handles non-media node reads/actions and guarded raw command invocation through Gateway.
 */
import crypto from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  jsonResult,
  readFiniteNumberParam,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callGatewayTool } from "./gateway.js";
import { POLICY_REDIRECT_INVOKE_COMMANDS } from "./nodes-tool-media.js";
import { resolveAgentNodeId } from "./nodes-utils.js";

const BLOCKED_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
const DEDICATED_TOOL_INVOKE_COMMANDS = new Map([
  ["computer.act", "computer"],
  ["mobile.ui.observe", "mobile_ui"],
  ["mobile.ui.act", "mobile_ui"],
]);

const NODE_READ_ACTION_COMMANDS = {
  camera_list: "camera.list",
  notifications_list: "notifications.list",
  device_status: "device.status",
  device_info: "device.info",
  device_permissions: "device.permissions",
  device_health: "device.health",
} as const;

export type NodeCommandAction =
  | keyof typeof NODE_READ_ACTION_COMMANDS
  | "camera_ptz"
  | "notifications_action"
  | "location_get"
  | "which"
  | "invoke";

export async function executeNodeCommandAction(params: {
  action: NodeCommandAction;
  input: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  agentSessionKey?: string;
  allowMediaInvokeCommands?: boolean;
  mediaInvokeActions: Record<string, string>;
}): Promise<
  | ReturnType<typeof jsonResult>
  | { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
> {
  switch (params.action) {
    case "camera_ptz": {
      const node = readToolStringParam(params.input, "node", { required: true });
      const deviceId = readToolStringParam(params.input, "deviceId", { required: true });
      const ptzOperation = normalizeLowercaseStringOrEmpty(params.input.ptzOperation);
      if (
        ptzOperation !== "status" &&
        ptzOperation !== "set" &&
        ptzOperation !== "move" &&
        ptzOperation !== "home"
      ) {
        throw new Error("ptzOperation must be status|set|move|home");
      }
      const panDegrees = readFiniteNumberParam(params.input, "panDegrees");
      const tiltDegrees = readFiniteNumberParam(params.input, "tiltDegrees");
      const zoomPercent = readFiniteNumberParam(params.input, "zoomPercent");
      const hasAxes =
        panDegrees !== undefined || tiltDegrees !== undefined || zoomPercent !== undefined;
      if ((ptzOperation === "status" || ptzOperation === "home") && hasAxes) {
        throw new Error(`${ptzOperation} does not accept axis values`);
      }
      if ((ptzOperation === "set" || ptzOperation === "move") && !hasAxes) {
        throw new Error(`${ptzOperation} requires at least one PTZ axis`);
      }
      const axes = { panDegrees, tiltDegrees, zoomPercent };
      const payload = await invokeNodeCommandPayload({
        gatewayOpts: params.gatewayOpts,
        node,
        command: ptzOperation === "status" ? "camera.ptz.status" : "camera.ptz.control",
        commandParams:
          ptzOperation === "status"
            ? { deviceId }
            : ptzOperation === "home"
              ? { deviceId, operation: "home" }
              : {
                  deviceId,
                  operation: ptzOperation,
                  [ptzOperation === "set" ? "target" : "delta"]: axes,
                },
      });
      return jsonResult(payload);
    }
    case "camera_list":
    case "notifications_list":
    case "device_status":
    case "device_info":
    case "device_permissions":
    case "device_health": {
      const node = readToolStringParam(params.input, "node", { required: true });
      const payloadRaw = await invokeNodeCommandPayload({
        gatewayOpts: params.gatewayOpts,
        node,
        command: NODE_READ_ACTION_COMMANDS[params.action],
      });
      const payload =
        payloadRaw && typeof payloadRaw === "object" && payloadRaw !== null ? payloadRaw : {};
      return jsonResult(payload);
    }
    case "notifications_action": {
      const node = readToolStringParam(params.input, "node", { required: true });
      const notificationKey = readToolStringParam(params.input, "notificationKey", {
        required: true,
      });
      const notificationAction = normalizeLowercaseStringOrEmpty(params.input.notificationAction);
      if (
        notificationAction !== "open" &&
        notificationAction !== "dismiss" &&
        notificationAction !== "reply"
      ) {
        throw new Error("notificationAction must be open|dismiss|reply");
      }
      const notificationReplyText =
        typeof params.input.notificationReplyText === "string"
          ? params.input.notificationReplyText.trim()
          : undefined;
      if (notificationAction === "reply" && !notificationReplyText) {
        throw new Error("notificationReplyText required when notificationAction=reply");
      }
      const payloadRaw = await invokeNodeCommandPayload({
        gatewayOpts: params.gatewayOpts,
        node,
        command: "notifications.actions",
        commandParams: {
          key: notificationKey,
          action: notificationAction,
          replyText: notificationReplyText,
        },
      });
      const payload =
        payloadRaw && typeof payloadRaw === "object" && payloadRaw !== null ? payloadRaw : {};
      return jsonResult(payload);
    }
    case "location_get": {
      const node = readToolStringParam(params.input, "node", { required: true });
      const maxAgeMs = readNonNegativeIntegerParam(params.input, "maxAgeMs");
      const desiredAccuracy =
        params.input.desiredAccuracy === "coarse" ||
        params.input.desiredAccuracy === "balanced" ||
        params.input.desiredAccuracy === "precise"
          ? params.input.desiredAccuracy
          : undefined;
      const locationTimeoutMs = readPositiveIntegerParam(params.input, "locationTimeoutMs");
      const payload = await invokeNodeCommandPayload({
        gatewayOpts: params.gatewayOpts,
        node,
        command: "location.get",
        commandParams: {
          maxAgeMs,
          desiredAccuracy,
          timeoutMs: locationTimeoutMs,
        },
      });
      return jsonResult(payload);
    }
    case "which": {
      const node = readToolStringParam(params.input, "node", { required: true });
      const bins = readStringArrayParam(params.input, "bins", { required: true });
      const payload = await invokeNodeCommandPayload({
        gatewayOpts: params.gatewayOpts,
        node,
        command: "system.which",
        commandParams: { bins },
      });
      return jsonResult(payload);
    }
    case "invoke": {
      const node = readToolStringParam(params.input, "node", { required: true });
      const nodeId = await resolveAgentNodeId(params.gatewayOpts, node);
      const invokeCommand = readToolStringParam(params.input, "invokeCommand", { required: true });
      const invokeCommandNormalized = normalizeLowercaseStringOrEmpty(invokeCommand);
      if (BLOCKED_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
        throw new Error(
          `invokeCommand "${invokeCommand}" is reserved for shell execution; use exec with host=node instead`,
        );
      }
      const dedicatedTool = DEDICATED_TOOL_INVOKE_COMMANDS.get(invokeCommandNormalized);
      if (dedicatedTool) {
        throw new Error(
          `invokeCommand "${invokeCommand}" cannot be invoked through the generic nodes surface; use the dedicated ${dedicatedTool} tool`,
        );
      }
      const dedicatedAction = params.mediaInvokeActions[invokeCommandNormalized];
      // Policy-redirect commands (file-transfer) ALWAYS reroute to their
      // dedicated tool. The dedicated tool runs gatekeep() + path policy
      // + operator approval; the generic invoke path doesn't. Operators
      // who set allowMediaInvokeCommands=true to allow camera/screen
      // bytes via raw invoke must not also get a path-policy bypass for
      // file-transfer.
      if (dedicatedAction && POLICY_REDIRECT_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
        throw new Error(
          `invokeCommand "${invokeCommand}" enforces a path-allowlist policy and cannot be invoked via the generic nodes.invoke surface; use the dedicated file-transfer tool "${dedicatedAction}"`,
        );
      }
      if (dedicatedAction && !params.allowMediaInvokeCommands) {
        throw new Error(
          `invokeCommand "${invokeCommand}" returns media payloads and is blocked to prevent base64 context bloat; use action="${dedicatedAction}"`,
        );
      }
      const invokeParamsJson =
        typeof params.input.invokeParamsJson === "string"
          ? params.input.invokeParamsJson.trim()
          : "";
      let invokeParams: unknown = {};
      if (invokeParamsJson) {
        try {
          invokeParams = JSON.parse(invokeParamsJson);
        } catch (err) {
          const message = formatErrorMessage(err);
          throw new Error(`invokeParamsJson must be valid JSON: ${message}`, {
            cause: err,
          });
        }
      }
      const invokeTimeoutMs = readPositiveIntegerParam(params.input, "invokeTimeoutMs");
      const raw = await callGatewayTool("node.invoke", params.gatewayOpts, {
        nodeId,
        command: invokeCommand,
        params: invokeParams,
        timeoutMs: invokeTimeoutMs,
        idempotencyKey: crypto.randomUUID(),
        ...(params.agentSessionKey ? { sessionKey: params.agentSessionKey } : {}),
      });
      return jsonResult(raw ?? {});
    }
  }
  throw new Error("Unsupported node command action");
}

async function invokeNodeCommandPayload(params: {
  gatewayOpts: GatewayCallOptions;
  node: string;
  command: string;
  commandParams?: Record<string, unknown>;
}): Promise<unknown> {
  const nodeId = await resolveAgentNodeId(params.gatewayOpts, params.node);
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", params.gatewayOpts, {
    nodeId,
    command: params.command,
    params: params.commandParams ?? {},
    idempotencyKey: crypto.randomUUID(),
  });
  return raw && typeof raw === "object" && Object.hasOwn(raw, "payload") ? raw.payload : {};
}
