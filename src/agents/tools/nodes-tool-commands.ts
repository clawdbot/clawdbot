import crypto from "node:crypto";
import { parseTimeoutMs } from "../../cli/parse-timeout.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { jsonResult, readStringParam } from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callGatewayTool } from "./gateway.js";
import { POLICY_REDIRECT_INVOKE_COMMANDS } from "./nodes-tool-media.js";
import { resolveNodeId } from "./nodes-utils.js";

export const BLOCKED_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);

export const NODE_READ_ACTION_COMMANDS = {
  camera_list: "camera.list",
  notifications_list: "notifications.list",
  device_status: "device.status",
  device_info: "device.info",
  device_permissions: "device.permissions",
  device_health: "device.health",
} as const;

export type NodeCommandAction =
  | keyof typeof NODE_READ_ACTION_COMMANDS
  | "notifications_action"
  | "location_get"
  | "invoke";

export async function executeNodeCommandAction(params: {
  action: NodeCommandAction;
  input: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  allowMediaInvokeCommands?: boolean;
  mediaInvokeActions: Record<string, string>;
}): Promise<
  | ReturnType<typeof jsonResult>
  | { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
> {
  switch (params.action) {
    case "camera_list":
    case "notifications_list":
    case "device_status":
    case "device_info":
    case "device_permissions":
    case "device_health": {
      const node = readStringParam(params.input, "node", { required: true });
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
      const node = readStringParam(params.input, "node", { required: true });
      const notificationKey = readStringParam(params.input, "notificationKey", { required: true });
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
      const node = readStringParam(params.input, "node", { required: true });
      const maxAgeMs =
        typeof params.input.maxAgeMs === "number" && Number.isFinite(params.input.maxAgeMs)
          ? params.input.maxAgeMs
          : undefined;
      const desiredAccuracy =
        params.input.desiredAccuracy === "coarse" ||
        params.input.desiredAccuracy === "balanced" ||
        params.input.desiredAccuracy === "precise"
          ? params.input.desiredAccuracy
          : undefined;
      const locationTimeoutMs =
        typeof params.input.locationTimeoutMs === "number" &&
        Number.isFinite(params.input.locationTimeoutMs)
          ? params.input.locationTimeoutMs
          : undefined;
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
    case "invoke": {
      const node = readStringParam(params.input, "node", { required: true });
      const nodeId = await resolveNodeId(params.gatewayOpts, node);
      const invokeCommand = readStringParam(params.input, "invokeCommand", { required: true });
      const invokeCommandNormalized = normalizeLowercaseStringOrEmpty(invokeCommand);
      if (BLOCKED_INVOKE_COMMANDS.has(invokeCommandNormalized)) {
        throw new Error(
          `invokeCommand "${invokeCommand}" is reserved for shell execution; use exec with host=node instead`,
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
      const invokeTimeoutMs = parseTimeoutMs(params.input.invokeTimeoutMs);
      const raw = await callGatewayTool("node.invoke", params.gatewayOpts, {
        nodeId,
        command: invokeCommand,
        params: invokeParams,
        timeoutMs: invokeTimeoutMs,
        idempotencyKey: crypto.randomUUID(),
      });
      return jsonResult(raw ?? {});
    }
  }
  throw new Error("Unsupported node command action");
}

export async function invokeNodeCommandPayload(params: {
  gatewayOpts: GatewayCallOptions;
  node: string;
  command: string;
  commandParams?: Record<string, unknown>;
}): Promise<unknown> {
  const nodeId = await resolveNodeId(params.gatewayOpts, params.node);
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", params.gatewayOpts, {
    nodeId,
    command: params.command,
    params: params.commandParams ?? {},
    idempotencyKey: crypto.randomUUID(),
  });
  return raw?.payload ?? {};
}
