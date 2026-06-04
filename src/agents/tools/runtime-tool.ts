import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  RUNTIME_SELF_CONTEXT_TOOL_NAME,
  shouldExposeRuntimeSelfContext,
} from "../../runtime-self-context/render.js";
import type {
  RuntimeContextConfig,
  RuntimeOffloadTarget,
  RuntimeSelfContext,
} from "../../runtime-self-context/types.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, ToolInputError, jsonResult, readStringParam } from "./common.js";

const RuntimeToolActions = [
  "self",
  "describe",
  "actions",
  "offload_targets",
  "cost_estimate",
] as const;

const RuntimeDescribeIncludes = [
  "current",
  "resources",
  "limits",
  "actions",
  "offload",
  "cost",
  "freshness",
  "provenance",
] as const;

const RuntimeWorkloadKinds = [
  "codex",
  "shell",
  "build",
  "test",
  "long_task",
  "gpu_compute",
  "media",
  "generic",
] as const;

const RuntimeToolSchema = Type.Object(
  {
    action: stringEnum(RuntimeToolActions, {
      description:
        "self returns the configured runtime context; describe can filter sections; actions lists scale/offload action refs; offload_targets lists target summaries; cost_estimate returns the configured cost hint for a target.",
    }),
    include: Type.Optional(
      Type.Array(stringEnum(RuntimeDescribeIncludes), {
        description: "Sections to include for action=describe. Omit for all configured sections.",
      }),
    ),
    targetId: Type.Optional(
      Type.String({
        description: "Offload target id for action=cost_estimate.",
      }),
    ),
    workload: Type.Optional(
      Type.Object(
        {
          kind: Type.Optional(stringEnum(RuntimeWorkloadKinds)),
          estimatedSeconds: Type.Optional(Type.Number({ minimum: 0 })),
          notes: Type.Optional(Type.String()),
        },
        {
          additionalProperties: false,
          description: "Optional workload hint for future provider-backed estimates.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

function resolveRuntimeContext(config: OpenClawConfig | undefined): RuntimeContextConfig | null {
  const runtimeContext = config?.runtimeContext;
  return shouldExposeRuntimeSelfContext(runtimeContext) ? (runtimeContext ?? null) : null;
}

function unavailableRuntimeValueResult(config: RuntimeContextConfig) {
  return jsonResult({
    status: "unavailable",
    source: config.source ?? "static",
    expose: config.expose ?? { mode: "tool_hint" },
    ttlSeconds: config.ttlSeconds,
    validUntil: config.validUntil,
    reason: "Runtime context is configured but no runtime value is available.",
  });
}

function readInclude(
  params: Record<string, unknown>,
): Set<(typeof RuntimeDescribeIncludes)[number]> {
  const raw = params.include;
  if (raw === undefined) {
    return new Set(RuntimeDescribeIncludes);
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("include must be an array");
  }
  const allowed = new Set<string>(RuntimeDescribeIncludes);
  const values = raw.map((entry, index) => {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new ToolInputError(`include[${index}] must be a supported runtime section`);
    }
    return entry as (typeof RuntimeDescribeIncludes)[number];
  });
  return new Set(values);
}

function pickRuntimeContext(
  context: RuntimeSelfContext,
  include: Set<(typeof RuntimeDescribeIncludes)[number]>,
): Partial<RuntimeSelfContext> & Pick<RuntimeSelfContext, "id" | "label"> {
  return {
    id: context.id,
    ...(context.label ? { label: context.label } : {}),
    ...(include.has("current") && context.current ? { current: context.current } : {}),
    ...(include.has("resources") && context.resources ? { resources: context.resources } : {}),
    ...(include.has("limits") && context.limits ? { limits: context.limits } : {}),
    ...(include.has("actions") && context.actions ? { actions: context.actions } : {}),
    ...(include.has("offload") && context.offload ? { offload: context.offload } : {}),
    ...(include.has("cost") && context.cost ? { cost: context.cost } : {}),
    ...(include.has("freshness") && context.freshness ? { freshness: context.freshness } : {}),
    ...(include.has("provenance") && context.provenance ? { provenance: context.provenance } : {}),
  };
}

function findOffloadTarget(
  context: RuntimeSelfContext,
  targetId: string | undefined,
): RuntimeOffloadTarget | undefined {
  const targets = context.offload?.targets ?? [];
  if (!targetId) {
    if (targets.length > 1) {
      throw new ToolInputError("targetId required when multiple offload targets are configured");
    }
    return targets[0];
  }
  return targets.find((target) => target.id === targetId);
}

export function createRuntimeTool(options: { config?: OpenClawConfig }): AnyAgentTool | null {
  const runtimeContext = resolveRuntimeContext(options.config);
  if (!runtimeContext) {
    return null;
  }
  return {
    label: "Runtime",
    name: RUNTIME_SELF_CONTEXT_TOOL_NAME,
    description:
      "Inspect this conversation's configured runtime context, scale/offload action refs, offload targets, and cost hints.",
    parameters: RuntimeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", {
        required: true,
        label: "action",
      }) as (typeof RuntimeToolActions)[number];
      if (!RuntimeToolActions.includes(action)) {
        throw new ToolInputError(`action must be one of ${RuntimeToolActions.join(", ")}`);
      }

      const context = runtimeContext.value;
      if (!context) {
        return unavailableRuntimeValueResult(runtimeContext);
      }
      if (action === "self") {
        return jsonResult({
          source: runtimeContext.source ?? "static",
          expose: runtimeContext.expose ?? { mode: "tool_hint" },
          ttlSeconds: runtimeContext.ttlSeconds,
          validUntil: runtimeContext.validUntil,
          value: context,
        });
      }
      if (action === "describe") {
        return jsonResult({
          value: pickRuntimeContext(context, readInclude(params)),
        });
      }
      if (action === "actions") {
        return jsonResult({
          actions: context.actions ?? [],
          offloadActions: (context.offload?.targets ?? []).map((target) => ({
            targetId: target.id,
            actions: target.actions ?? {},
          })),
        });
      }
      if (action === "offload_targets") {
        return jsonResult({
          targets: context.offload?.targets ?? [],
        });
      }

      const targetId = readStringParam(params, "targetId");
      const target = findOffloadTarget(context, targetId);
      if (targetId && !target) {
        return jsonResult({
          targetId,
          estimate: {
            status: "target_not_found",
            reason: "No configured offload target matched targetId.",
          },
        });
      }
      return jsonResult({
        targetId: target?.id ?? targetId,
        cost: target?.cost ?? { model: "unknown" },
        workload: params.workload,
        estimate: {
          status: "not_available",
          reason: "No provider-backed runtime cost estimator is registered in this v1 slice.",
        },
      });
    },
  };
}
