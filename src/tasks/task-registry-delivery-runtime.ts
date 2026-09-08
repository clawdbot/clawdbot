import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { getRuntimeConfig } from "../infra/outbound/message.config.runtime.js";

// Runtime delivery seam for task terminal/state-change notifications.
export { sendMessage } from "../infra/outbound/message.js";

export function resolveTaskControlUiSessionUrl(params: {
  sessionKey: string;
  fallbackAgentId?: string;
}): string | undefined {
  return resolveControlUiSessionUrl(getRuntimeConfig(), { ...params, exactKey: true });
}
