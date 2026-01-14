import { Type } from "@sinclair/typebox";
import {
  normalizeCronJobCreate,
  normalizeCronJobPatch,
} from "../../cron/normalize.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

// NOTE: We use Type.Object({}, { additionalProperties: true }) for job/patch
// instead of CronAddParamsSchema/CronJobPatchSchema because the gateway schemas
// contain nested unions. Tool schemas need to stay provider-friendly, so we
// accept "any object" here and validate at runtime.

const CRON_ACTIONS = [
  "status",
  "list",
  "add",
  "update",
  "remove",
  "run",
  "runs",
  "wake",
] as const;

const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;

// Flattened schema: runtime validates per-action requirements.
const CronToolSchema = Type.Object({
  action: stringEnum(CRON_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  includeDisabled: Type.Optional(Type.Boolean()),
  job: Type.Optional(Type.Object({}, { additionalProperties: true })),
  jobId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  patch: Type.Optional(Type.Object({}, { additionalProperties: true })),
  text: Type.Optional(Type.String()),
  mode: optionalStringEnum(CRON_WAKE_MODES),
});

export function createCronTool(): AnyAgentTool {
  return {
    label: "Cron",
    name: "cron",
    description:
      "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events. Use `jobId` as the canonical identifier; `id` is accepted for compatibility.",
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
          const id =
            readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error(
              "jobId required (id accepted for backward compatibility)",
            );
          }
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
          const id =
            readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error(
              "jobId required (id accepted for backward compatibility)",
            );
          }
          return jsonResult(
            await callGatewayTool("cron.remove", gatewayOpts, { id }),
          );
        }
        case "run": {
          const id =
            readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error(
              "jobId required (id accepted for backward compatibility)",
            );
          }
          return jsonResult(
            await callGatewayTool("cron.run", gatewayOpts, { id }),
          );
        }
        case "runs": {
          const id =
            readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error(
              "jobId required (id accepted for backward compatibility)",
            );
          }
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
