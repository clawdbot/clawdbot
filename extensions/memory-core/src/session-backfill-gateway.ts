import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { listAgentIds } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryRemDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { SessionBackfillResult } from "./session-backfill-contract.js";
import { normalizeSessionBackfillSelection } from "./session-backfill-selection.js";

const SESSION_BACKFILL_GATEWAY_METHODS = {
  preview: "memory.sessionBackfill.preview",
  apply: "memory.sessionBackfill.apply",
  rollback: "memory.sessionBackfill.rollback",
} as const;

type SessionBackfillGatewayParams = {
  agentId: string;
  from?: string;
  to?: string;
  limitDays: number;
};

type SessionBackfillGatewayResult = {
  days: number;
  candidates: number;
  perDay: Array<{ day: string; candidateCount: number; sample: string[] }>;
  staged: number;
  truncated?: boolean;
  cursor?: {
    advanced: boolean;
    exhausted: boolean;
    hasMore: boolean;
  };
};

class InvalidSessionBackfillRequestError extends Error {}

const loadSessionBackfillGatewayRuntime = createLazyRuntimeModule(
  () => import("./session-backfill-gateway.runtime.js"),
);

function paramsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("params must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(params: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`unexpected parameter: ${unexpected[0]}`);
  }
}

function readOptionalSessionBoundary(params: Record<string, unknown>, key: "from" | "to") {
  const raw = params[key];
  if (raw !== undefined && typeof raw !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return readStringParam(params, key);
}

function readGatewayParams(value: unknown): SessionBackfillGatewayParams {
  const params = paramsRecord(value);
  assertOnlyKeys(params, new Set(["agentId", "from", "to", "limitDays"]));
  const agentId = normalizeAgentId(readStringParam(params, "agentId", { required: true }));
  const selection = normalizeSessionBackfillSelection(
    {
      from: readOptionalSessionBoundary(params, "from"),
      to: readOptionalSessionBoundary(params, "to"),
      limitDays: readPositiveIntegerParam(params, "limitDays"),
    },
    { from: "from", to: "to", limitDays: "limitDays" },
  );
  return { agentId, ...selection };
}

function readRollbackParams(value: unknown): { agentId: string } {
  const params = paramsRecord(value);
  assertOnlyKeys(params, new Set(["agentId"]));
  return {
    agentId: normalizeAgentId(readStringParam(params, "agentId", { required: true })),
  };
}

function resolveExecutionContext(api: OpenClawPluginApi, agentId: string) {
  const config = api.runtime.config.current() as OpenClawConfig;
  const configuredAgentIds = listAgentIds(config);
  if (!configuredAgentIds.includes(agentId)) {
    throw new InvalidSessionBackfillRequestError(`Unknown agent id "${agentId}".`);
  }
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
  const pluginConfig = resolvePluginConfigObject(config, "memory-core");
  const remConfig = resolveMemoryRemDreamingConfig({
    cfg: config,
    pluginConfig,
  });
  return {
    workspaceDir,
    ...(pluginConfig ? { pluginConfig } : {}),
    ...(remConfig.timezone !== undefined ? { timezone: remConfig.timezone } : {}),
  };
}

function gatewayResult(
  result: SessionBackfillResult,
  options: {
    includeCursor: boolean;
    continuation: { advanced: boolean; hasMore: boolean };
  },
): SessionBackfillGatewayResult {
  return {
    days: result.days.length,
    candidates: result.candidateCount,
    perDay: result.days.map((day) => ({
      day: day.day,
      candidateCount: day.candidateCount,
      sample: day.topCandidates.slice(0, 3),
    })),
    staged: result.stagedEntries,
    ...(!options.includeCursor ? { truncated: options.continuation.hasMore } : {}),
    ...(options.includeCursor
      ? {
          cursor: {
            advanced: options.continuation.advanced,
            exhausted: result.candidateCount === 0 && !options.continuation.hasMore,
            hasMore: options.continuation.hasMore,
          },
        }
      : {}),
  };
}

function respondInvalid(respond: GatewayRequestHandlerOptions["respond"], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function respondUnavailable(
  respond: GatewayRequestHandlerOptions["respond"],
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

export function registerSessionBackfillGatewayMethods(api: OpenClawPluginApi): void {
  const registerBackfill = (
    method: (typeof SESSION_BACKFILL_GATEWAY_METHODS)["preview" | "apply"],
    apply: boolean,
  ) => {
    api.registerGatewayMethod(
      method,
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        let request: SessionBackfillGatewayParams;
        try {
          request = readGatewayParams(params);
        } catch (error) {
          respondInvalid(respond, error);
          return;
        }
        try {
          const context = resolveExecutionContext(api, request.agentId);
          const { executeSessionBackfillBatch } = await loadSessionBackfillGatewayRuntime();
          const execution = await executeSessionBackfillBatch({
            ...request,
            ...context,
            ...(apply ? { apply: true } : {}),
          });
          respond(
            true,
            gatewayResult(execution.result, {
              includeCursor: apply,
              continuation: execution.continuation,
            }),
          );
        } catch (error) {
          if (error instanceof InvalidSessionBackfillRequestError) {
            respondInvalid(respond, error);
          } else {
            respondUnavailable(respond, error);
          }
        }
      },
      { scope: apply ? "operator.admin" : "operator.read" },
    );
  };

  registerBackfill(SESSION_BACKFILL_GATEWAY_METHODS.preview, false);
  registerBackfill(SESSION_BACKFILL_GATEWAY_METHODS.apply, true);
  api.registerGatewayMethod(
    SESSION_BACKFILL_GATEWAY_METHODS.rollback,
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      let request: { agentId: string };
      try {
        request = readRollbackParams(params);
      } catch (error) {
        respondInvalid(respond, error);
        return;
      }
      try {
        const context = resolveExecutionContext(api, request.agentId);
        const { executeSessionBackfill } = await loadSessionBackfillGatewayRuntime();
        const result = await executeSessionBackfill({ ...request, ...context, rollback: true });
        respond(true, {
          removedDiaryEntries: result.rollback?.removedDiaryEntries ?? 0,
          removedStagedEntries: result.rollback?.removedStagedEntries ?? 0,
        });
      } catch (error) {
        if (error instanceof InvalidSessionBackfillRequestError) {
          respondInvalid(respond, error);
        } else {
          respondUnavailable(respond, error);
        }
      }
    },
    { scope: "operator.admin" },
  );
}
