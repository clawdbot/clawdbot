/** Gateway config reads and owner-requested self-updates. */
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  summarizeUpdateRunResponse,
} from "../../gateway/update-run-summary.js";
import { parseConfigPathArrayIndex } from "../../shared/path-array-index.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readToolStringParam,
  textResult,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { callInProcessGatewayTool, getInProcessGatewayToolContext } from "./in-process-gateway.js";

// Keep complete JSON below the smallest default tool-result presentation budget.
const MAX_GATEWAY_CONFIG_GET_TEXT_CHARS = 12_000;
const CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE = "config schema path not found";

function getSnapshotConfig(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("config.get response is not an object.");
  }
  const config = (snapshot as { config?: unknown }).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config.get response is missing a config object.");
  }
  return config as Record<string, unknown>;
}

function splitGatewayConfigGetPath(path: string): string[] {
  return path
    .trim()
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

function resolveGatewayConfigGetPath(config: Record<string, unknown>, path: string): unknown {
  const parts = splitGatewayConfigGetPath(path);
  if (parts.length === 0) {
    return undefined;
  }
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(part);
      if (index === undefined || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function selectGatewayConfigGetResult(snapshot: unknown, path: string | undefined): unknown {
  if (!path) {
    return snapshot;
  }
  const value = resolveGatewayConfigGetPath(getSnapshotConfig(snapshot), path);
  if (value === undefined) {
    throw new ToolInputError(`config path not found: ${path}`);
  }
  const hash = readStringValue((snapshot as { hash?: unknown }).hash);
  return {
    ...(hash ? { hash } : {}),
    path,
    config: value,
  };
}

function createGatewayConfigGetToolResult(result: unknown) {
  const text = JSON.stringify({ ok: true, result }, null, 2);
  if (text.length > MAX_GATEWAY_CONFIG_GET_TEXT_CHARS) {
    throw new ToolInputError(
      "config.get response is too large; use path to request a narrower config subtree",
    );
  }
  return textResult(text, { ok: true });
}

function isConfigSchemaPathNotFoundError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes(CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE)
  );
}

const GATEWAY_ACTIONS = ["config.get", "config.schema.lookup", "update.run"] as const;

const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  ...gatewayCallOptionSchemaProperties(),
  note: Type.Optional(
    Type.String({ description: "Short human note for the post-update restart notice." }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Required for config.schema.lookup; optional for config.get.",
    }),
  ),
});

export function createGatewayTool(options?: {
  senderIsOwner?: boolean;
  requesterSenderId?: string | null;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    description:
      "Read gateway config/schema. update.run: owner-only update on explicit user request; restart + completion notice automatic. Never via shell.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (action === "update.run") {
        const caller = getGatewayToolCallerIdentity();
        if (options?.senderIsOwner !== true) {
          const hint = formatCommandOwnerHint({
            channel: caller?.turnSourceChannel,
            id: options?.requesterSenderId,
          });
          return jsonResult({
            ok: false,
            code: "owner_required",
            message: `Only the OpenClaw owner can start an update from chat. ${hint}`,
          });
        }
        // Routing comes from the admitted caller, never model-authored destinations or credentials.
        const deliveryContext = caller
          ? {
              channel: caller.turnSourceChannel,
              to: caller.turnSourceTo,
              accountId: caller.turnSourceAccountId,
              threadId: caller.turnSourceThreadId,
            }
          : undefined;
        const result = await callInProcessGatewayTool(
          "update.run",
          {
            requester: {
              channel: caller?.turnSourceChannel,
              accountId: caller?.turnSourceAccountId,
              senderId: options?.requesterSenderId ?? undefined,
            },
            sessionKey: caller?.sessionKey,
            deliveryContext,
            note: readToolStringParam(params, "note"),
            timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
          },
          {
            // An explicit binding prevents the standalone client's remote fallback.
            resolveGatewayContext: getInProcessGatewayToolContext,
            timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
            signal,
          },
        );
        return jsonResult(summarizeUpdateRunResponse(result));
      }
      const gatewayOpts = readGatewayCallOptions(params);

      if (action === "config.get") {
        const path = readToolStringParam(params, "path");
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {}, { signal });
        const result = selectGatewayConfigGetResult(snapshot, path);
        return createGatewayConfigGetToolResult(result);
      }
      if (action === "config.schema.lookup") {
        const path = readToolStringParam(params, "path", {
          required: true,
          label: "path",
        });
        try {
          const result = await callGatewayTool(
            "config.schema.lookup",
            gatewayOpts,
            { path },
            { signal },
          );
          return jsonResult({ ok: true, result });
        } catch (error) {
          if (isConfigSchemaPathNotFoundError(error)) {
            return jsonResult({
              ok: false,
              code: "schema_path_not_found",
              path,
              message: CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE,
            });
          }
          throw error;
        }
      }
      throw new Error(`Unknown action: ${action}`);
    },
  };
}
