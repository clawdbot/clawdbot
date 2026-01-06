import { Type } from "@sinclair/typebox";
import {
  normalizeCronJobCreate,
  normalizeCronJobPatch,
} from "../../cron/normalize.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

// NOTE: We use Type.Object({}, { additionalProperties: true }) for job/patch
// instead of CronAddParamsSchema/CronJobPatchSchema because:
//
// 1. CronAddParamsSchema contains nested Type.Union (for schedule, payload, etc.)
// 2. TypeBox compiles Type.Union to JSON Schema `anyOf`
// 3. pi-ai's sanitizeSchemaForGoogle() strips `anyOf` from nested properties
// 4. This leaves empty schemas `{}` which Claude rejects as invalid
//
// The actual validation happens at runtime via normalizeCronJobCreate/Patch
// and the gateway's validateCronAddParams. This schema just needs to accept
// any object so the AI can pass through the job definition.
//
// See: https://github.com/anthropics/anthropic-cookbook/blob/main/misc/tool_use_best_practices.md
// Claude requires valid JSON Schema 2020-12 with explicit types.

const CronToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("list"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    includeDisabled: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("add"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    job: Type.Object({}, { additionalProperties: true }),
  }),
  Type.Object({
    action: Type.Literal("update"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    id: Type.String(),
    patch: Type.Object({}, { additionalProperties: true }),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    id: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("run"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    id: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("runs"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    id: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("wake"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    text: Type.String(),
    mode: Type.Optional(
      Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    ),
  }),
]);

export function createCronTool(): AnyAgentTool {
  return {
    label: "Cron",
    name: "cron",
    description:
      "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.",
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      switch (action) {
        case "status":
          return jsonResult(
            await callGatewayTool("cron.status", gatewayOpts, {}),
          );
        case "list":
          return jsonResult(
            await callGatewayTool("cron.list", gatewayOpts, {
              includeDisabled: Boolean(params.includeDisabled),
            }),
          );
        case "add": {
          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          const job = normalizeCronJobCreate(params.job) ?? params.job;
          return jsonResult(
            await callGatewayTool("cron.add", gatewayOpts, job),
          );
        }
        case "update": {
          const id = readStringParam(params, "id", { required: true });
          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("patch required");
          }
          const patch = normalizeCronJobPatch(params.patch) ?? params.patch;
          return jsonResult(
            await callGatewayTool("cron.update", gatewayOpts, {
              id,
              patch,
            }),
          );
        }
        case "remove": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult(
            await callGatewayTool("cron.remove", gatewayOpts, { id }),
          );
        }
        case "run": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult(
            await callGatewayTool("cron.run", gatewayOpts, { id }),
          );
        }
        case "runs": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult(
            await callGatewayTool("cron.runs", gatewayOpts, { id }),
          );
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGatewayTool(
              "wake",
              gatewayOpts,
              { mode, text },
              { expectFinal: false },
            ),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
