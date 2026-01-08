import { Type } from "@sinclair/typebox";

import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const GatewayToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("restart"),
    delayMs: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("config.get"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("config.schema"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("config.apply"),
    raw: Type.String(),
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Number()),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("update.run"),
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Number()),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
  }),
]);

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    description:
      "Restart, apply config, or update the gateway in-place (SIGUSR1). Use config.apply/update.run to write config or run updates with validation and restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayUrl =
        typeof params.gatewayUrl === "string" && params.gatewayUrl.trim()
          ? params.gatewayUrl.trim()
          : undefined;
      const gatewayToken =
        typeof params.gatewayToken === "string" && params.gatewayToken.trim()
          ? params.gatewayToken.trim()
          : undefined;
      const timeoutMs =
        typeof params.timeoutMs === "number" &&
        Number.isFinite(params.timeoutMs)
          ? Math.max(1, Math.floor(params.timeoutMs))
          : undefined;
      const gatewayOpts = { gatewayUrl, gatewayToken, timeoutMs };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema") {
        const result = await callGatewayTool("config.schema", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const raw = readStringParam(params, "raw", { required: true });
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim()
            ? params.note.trim()
            : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" &&
          Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim()
            ? params.note.trim()
            : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" &&
          Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        const result = await callGatewayTool("update.run", gatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
