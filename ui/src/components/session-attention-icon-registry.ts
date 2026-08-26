import type { TemplateResult } from "lit";
import type { SessionAgentAttentionIconId } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { icons } from "./icons.ts";

const SESSION_ATTENTION_ICON_REGISTRY = {
  hand: icons.hand,
  key: icons.key,
  alert: icons.alertTriangle,
  flag: icons.flag,
  lock: icons.lock,
  hourglass: icons.hourglass,
} as const satisfies Record<SessionAgentAttentionIconId, TemplateResult>;

export function resolveSessionAttentionIcon(icon: SessionAgentAttentionIconId): TemplateResult {
  return SESSION_ATTENTION_ICON_REGISTRY[icon];
}
