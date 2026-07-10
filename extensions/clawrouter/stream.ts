import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { prepareClawRouterRequestModel } from "./provider-catalog.js";

const ENV_API_KEY_MARKER = "CLAWROUTER_API_KEY";
const ATTRIBUTION_VALUE_MAX_LENGTH = 256;
const CLIENT_HEADER = "X-ClawRouter-Client";
const AGENT_HEADER = "X-ClawRouter-Agent-Id";
const SESSION_HEADER = "X-ClawRouter-Session-Id";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function sanitizeAttributionValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || hasControlCharacter(normalized)) {
    return undefined;
  }
  return normalized.slice(0, ATTRIBUTION_VALUE_MAX_LENGTH);
}

function findHeader(headers: Record<string, string>, target: string): string | undefined {
  const normalizedTarget = target.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

function setHeaderDefault(
  headers: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined && findHeader(headers, name) === undefined) {
    headers[name] = value;
  }
}

function withClawRouterHeaders(
  headers: Record<string, string> | undefined,
  params: { agentId?: string; apiKey?: string; sessionId?: string },
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "authorization" || !params.apiKey) {
      next[name] = value;
    }
  }
  setHeaderDefault(next, CLIENT_HEADER, "openclaw");
  setHeaderDefault(next, AGENT_HEADER, sanitizeAttributionValue(params.agentId));
  setHeaderDefault(next, SESSION_HEADER, sanitizeAttributionValue(params.sessionId));
  if (params.apiKey) {
    next.Authorization = `Bearer ${params.apiKey}`;
  }
  return next;
}

function createClawRouterStreamWrapper(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const underlying = ctx.streamFn;
  if (!underlying) {
    return undefined;
  }
  return (model, context, options) => {
    const apiKey = options?.apiKey?.trim();
    const preparedModel = prepareClawRouterRequestModel(model);
    return underlying(
      {
        ...preparedModel,
        headers: withClawRouterHeaders(preparedModel.headers, {
          agentId: ctx.agentId,
          apiKey: apiKey && apiKey !== ENV_API_KEY_MARKER ? apiKey : undefined,
          sessionId: options?.sessionId,
        }),
      },
      context,
      options,
    );
  };
}

export function wrapClawRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  return createClawRouterStreamWrapper(ctx);
}
