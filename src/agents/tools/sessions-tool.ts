/** Session self-service tool. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { SESSION_AGENT_ATTENTION_ICON_IDS } from "../../../packages/gateway-protocol/src/session-icon.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolAuthorizationError, ToolInputError } from "./common.js";
import {
  callInProcessGatewayTool,
  hasInProcessGatewayToolContext,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";
import { resolveSessionReference } from "./sessions-resolution.js";

const ACTIONS = ["patch", "group_list", "group_set", "group_rename", "group_delete"] as const;
const GROUP_NAME_MAX_LENGTH = 512;
const GROUP_NAMES_MAX_ITEMS = 200;

const SessionsToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: "Action" }),
    sessionKey: Type.Optional(Type.String({ description: "Target session. Default: current" })),
    label: Type.Optional(
      Type.String({ description: "Sidebar title override. Empty string clears it." }),
    ),
    icon: Type.Optional(
      Type.String({
        description:
          "Sidebar icon: an emoji, name:<curated-id>, or svg:<svg …> you draw yourself (tiny, sanitized). Empty string removes it.",
      }),
    ),
    statusNote: Type.Optional(
      Type.String({
        maxLength: 120,
        description:
          "Short sidebar status line. Empty string clears it and declared attention. Clears automatically when the user reads or replies, or when its TTL expires.",
      }),
    ),
    attention: Type.Optional(
      stringEnum(["clear", ...SESSION_AGENT_ATTENTION_ICON_IDS] as const, {
        description:
          "Request user attention with a curated icon; requires an active statusNote. 'clear' clears both attention and statusNote.",
      }),
    ),
    ttlMinutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Status/attention lifetime in minutes. Default 30; maximum 120.",
      }),
    ),
    pinned: Type.Optional(Type.Boolean({ description: "Pin session" })),
    archived: Type.Optional(
      Type.Boolean({ description: "True archives without deleting; false restores the session." }),
    ),
    model: Type.Optional(Type.String({ description: "Model override" })),
    thinkingLevel: Type.Optional(Type.String({ description: "Thinking override" })),
    names: Type.Optional(Type.Array(Type.String(), { description: "Ordered group names" })),
    name: Type.Optional(Type.String({ description: "Group name" })),
    to: Type.Optional(Type.String({ description: "New group name" })),
  },
  { additionalProperties: false },
);

type SessionsToolOptions = {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: InProcessGatewayCaller;
  hasInProcessGatewayContext?: () => boolean;
};

function readBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} must be boolean`);
  }
  return value;
}

function readInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new ToolInputError(`${key} must be an integer`);
  }
  return value as number;
}

function readClearableString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ToolInputError(`${key} must be a string`);
  }
  return value.trim() || null;
}

function readGroupName(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${label} required`);
  }
  const name = value.trim();
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    throw new ToolInputError(`${label} too long`);
  }
  return name;
}

function readGroupNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ToolInputError("names required");
  }
  if (value.length > GROUP_NAMES_MAX_ITEMS) {
    throw new ToolInputError("Too many group names");
  }
  return value.map((name, index) => readGroupName(name, `names[${index}]`));
}

async function resolvePatchTarget(
  opts: SessionsToolOptions,
  sessionKey: string | undefined,
): Promise<{ cfg: OpenClawConfig; key: string }> {
  const context = resolveSessionToolContext(opts);
  const rawKey = sessionKey ?? context.effectiveRequesterKey;
  const resolved = await resolveSessionReference({
    sessionKey: rawKey,
    alias: context.alias,
    mainKey: context.mainKey,
    requesterInternalKey: context.effectiveRequesterKey,
    restrictToSpawned: context.restrictToSpawned,
  });
  if (!resolved.ok) {
    throw new ToolInputError(resolved.error);
  }
  if (isIncognitoSessionKey(resolved.key)) {
    throw new ToolAuthorizationError(`Session not visible from session tools: ${rawKey}`);
  }
  if (resolved.key !== context.effectiveRequesterKey) {
    // Session visibility is the configured read/write scope for session tools;
    // the action only selects error copy. Owner gating remains separate.
    const guard = await createSessionVisibilityGuard({
      action: "status",
      requesterSessionKey: context.effectiveRequesterKey,
      requesterAgentId: resolveAgentIdFromSessionKey(context.effectiveRequesterKey),
      visibility: resolveEffectiveSessionToolsVisibility({
        cfg: context.cfg,
        sandboxed: opts.sandboxed === true,
      }),
      a2aPolicy: createAgentToAgentPolicy(context.cfg),
    });
    const access = guard.check(resolved.key);
    if (!access.allowed) {
      throw new ToolAuthorizationError(access.error);
    }
  }
  return { cfg: context.cfg, key: resolved.key };
}

export function createSessionsTool(opts: SessionsToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Sessions",
    name: "sessions",
    description:
      "Session settings and groups. patch/group_list/group_set/group_rename/group_delete.",
    parameters: SessionsToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "group_list") {
        return jsonResult(await gatewayCall("sessions.groups.list", {}));
      }
      // Group catalog is global by contract. Owner-only tool gating protects mutations.
      if (action === "group_set") {
        const names = readGroupNames(params.names);
        return jsonResult(await gatewayCall("sessions.groups.put", { names }));
      }
      if (action === "group_rename") {
        return jsonResult(
          await gatewayCall("sessions.groups.rename", {
            name: readGroupName(params.name, "name"),
            to: readGroupName(params.to, "to"),
          }),
        );
      }
      if (action === "group_delete") {
        return jsonResult(
          await gatewayCall("sessions.groups.delete", {
            name: readGroupName(params.name, "name"),
          }),
        );
      }
      if (action !== "patch") {
        throw new ToolInputError(`Unknown action: ${action}`);
      }

      const { key } = await resolvePatchTarget(
        { ...opts, config: opts.config ?? getRuntimeConfig() },
        normalizeOptionalString(readStringParam(params, "sessionKey")),
      );
      const patch = {
        key,
        ...(params.label !== undefined ? { label: readClearableString(params, "label") } : {}),
        ...(params.icon !== undefined ? { icon: readClearableString(params, "icon") } : {}),
        ...(params.statusNote !== undefined
          ? { statusNote: readClearableString(params, "statusNote") }
          : {}),
        ...(params.attention !== undefined
          ? {
              attention:
                readStringParam(params, "attention", { required: true }) === "clear"
                  ? null
                  : readStringParam(params, "attention", { required: true }),
            }
          : {}),
        ...(params.ttlMinutes !== undefined
          ? { ttlMinutes: readInteger(params, "ttlMinutes") }
          : {}),
        ...(params.pinned !== undefined ? { pinned: readBoolean(params, "pinned") } : {}),
        ...(params.archived !== undefined ? { archived: readBoolean(params, "archived") } : {}),
        ...(params.model !== undefined
          ? { model: readStringParam(params, "model", { required: true }) }
          : {}),
        ...(params.thinkingLevel !== undefined
          ? { thinkingLevel: readStringParam(params, "thinkingLevel", { required: true }) }
          : {}),
      };
      if (Object.keys(patch).length === 1) {
        throw new ToolInputError("Patch setting required");
      }
      const inProcessGatewayAvailable =
        opts.hasInProcessGatewayContext?.() ??
        (opts.callGateway ? true : hasInProcessGatewayToolContext());
      if (patch.model !== undefined && !inProcessGatewayAvailable) {
        return jsonResult({
          status: "forbidden",
          error: "Model patch needs in-process gateway.",
        });
      }
      const result =
        patch.model === undefined
          ? await gatewayCall("sessions.patch", patch)
          : await withAgentSessionModelPatchOrigin(
              async () => await gatewayCall("sessions.patch", patch),
            );
      return jsonResult(result);
    },
  };
}
