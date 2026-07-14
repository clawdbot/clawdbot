/**
 * gateway built-in tool.
 *
 * Exposes selected Gateway control/config/update actions with fail-closed config mutation boundaries.
 */
import { isRecord as isPlainObject } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { resolveConfigSnapshotHash } from "../../config/io.js";
import { normalizeConfigPatchReplacePaths } from "../../config/patch-replace-paths.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  buildRestartSuccessContinuation,
  clearRestartSentinel,
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseConfigPathArrayIndex } from "../../shared/path-array-index.js";
import { optionalNonNegativeIntegerSchema, stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readStringArrayParam,
  readStringParam,
  textResult,
  ToolInputError,
} from "./common.js";
import { assertGatewayConfigMutationAllowed } from "./gateway-config-guard.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;
// Keep complete JSON below the smallest default tool-result presentation budget.
const MAX_GATEWAY_CONFIG_GET_TEXT_CHARS = 12_000;
const CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE = "config schema path not found";

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: readStringValue(hashValue),
    raw: readStringValue(rawValue),
  });
  return hash ?? undefined;
}

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

// Direct RPC callers need the validated config echoed after writes; the
// agent-facing gateway tool does not, and replaying it bloats transcripts.
function stripConfigWriteResultPayload(result: unknown): unknown {
  if (!isPlainObject(result) || !Object.hasOwn(result, "config")) {
    return result;
  }
  const stripped = { ...result };
  delete stripped.config;
  return stripped;
}

function isConfigSchemaPathNotFoundError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes(CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE)
  );
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "update.run",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: optionalNonNegativeIntegerSchema(),
  reason: Type.Optional(Type.String()),
  continuationMessage: Type.Optional(Type.String()),
  // config.get, config.schema.lookup, config.apply, update.run
  ...gatewayCallOptionSchemaProperties(),
  // config.get, config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  replacePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 256 })),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: optionalNonNegativeIntegerSchema(),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    description:
      "Gateway restart/config/update. Before config edit: config.schema.lookup exact dot path. Partial merge: config.patch; full replace only: config.apply. Removing array entries via patch needs exact array replacePaths. Writes hot-reload/restart as needed. Always human note for post-restart delivery. Internal continuation: one-shot continuationMessage; its visible follow-up uses message tool. Never write restart sentinel directly.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const sessionKey =
          normalizeOptionalString(opts?.agentSessionKey) ??
          normalizeOptionalString(params.sessionKey);
        const delayMs = readNonNegativeIntegerParam(params, "delayMs");
        const rawReason = normalizeOptionalString(params.reason);
        const reason = rawReason ? truncateUtf16Safe(rawReason, 200) : undefined;
        const note = normalizeOptionalString(params.note);
        const continuationMessage = normalizeOptionalString(params.continuationMessage);
        // Extract channel + threadId for routing after restart.
        // Uses generic :thread: parsing plus plugin-owned session grammars.
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          continuation: buildRestartSuccessContinuation({
            sessionKey,
            continuationMessage,
          }),
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        let sentinelWritten = false;
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
          // Ownership and sentinel routing use the same trusted session identity,
          // so model-supplied params cannot queue work into another session.
          sessionKey,
          emitHooks: {
            beforeEmit: async () => {
              await writeRestartSentinel(payload);
              sentinelWritten = true;
            },
            afterEmitRejected: async () => {
              if (sentinelWritten) {
                await clearRestartSentinel();
              }
            },
          },
        });
        return jsonResult({
          ...scheduled,
          ...(payload.continuation ? { continuationQueued: scheduled.emitHooksQueued } : {}),
        });
      }

      const gatewayOpts = readGatewayCallOptions(params);

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey =
          normalizeOptionalString(opts?.agentSessionKey) ??
          normalizeOptionalString(params.sessionKey);
        const note = normalizeOptionalString(params.note);
        const restartDelayMs = readNonNegativeIntegerParam(params, "restartDelayMs");
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        snapshotConfig: Record<string, unknown>;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
        replacePaths: string[] | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        const rawReplacePaths =
          action === "config.patch" ? readStringArrayParam(params, "replacePaths") : undefined;
        const replacePaths = rawReplacePaths
          ? [...normalizeConfigPatchReplacePaths(rawReplacePaths)]
          : undefined;
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
        // Always fetch config.get so we can compare protected exec settings
        // against the current snapshot before forwarding any write RPC.
        const snapshotConfig = getSnapshotConfig(snapshot);
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, snapshotConfig, replacePaths, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const path = readStringParam(params, "path");
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
        const result = selectGatewayConfigGetResult(snapshot, path);
        return createGatewayConfigGetToolResult(result);
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", {
          required: true,
          label: "path",
        });
        try {
          const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
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
      if (action === "config.apply") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.apply",
          currentConfig: snapshotConfig,
          raw,
        });
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result: stripConfigWriteResultPayload(result) });
      }
      if (action === "config.patch") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs, replacePaths } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.patch",
          currentConfig: snapshotConfig,
          raw,
          replacePaths,
        });
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
          ...(replacePaths ? { replacePaths } : {}),
        });
        return jsonResult({ ok: true, result: stripConfigWriteResultPayload(result) });
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const continuationMessage = normalizeOptionalString(params.continuationMessage);
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          continuationMessage,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
