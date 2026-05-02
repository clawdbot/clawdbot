import type {
  NativeHookRelayEvent,
  NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonObject, JsonValue } from "./protocol.js";

export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

export function buildCodexNativeHookRelayConfig(params: {
  relay: NativeHookRelayRegistrationHandle;
  events?: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
}): JsonObject {
  const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
  const config: JsonObject = {
    "features.codex_hooks": true,
  };
  for (const event of events) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    config[`hooks.${codexEvent}`] = [
      {
        matcher: null,
        hooks: [
          {
            type: "command",
            command: params.relay.commandForEvent(event),
            timeout: normalizeHookTimeoutSec(params.hookTimeoutSec),
            async: false,
            statusMessage: "OpenClaw native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
  }
  return config;
}

export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.codex_hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

function normalizeHookTimeoutSec(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 5;
}
