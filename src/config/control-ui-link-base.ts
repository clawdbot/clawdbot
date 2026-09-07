import {
  buildControlUiSessionPath,
  normalizeControlUiBasePath,
} from "@openclaw/session-url-contract";
import { resolveGatewayPublicOrigin } from "./gateway-public-origin.js";
import type { OpenClawConfig } from "./types.js";

type ControlUiLinkConfig = Pick<OpenClawConfig, "gateway"> | null | undefined;

export function resolveControlUiLinkLocation(
  cfg: ControlUiLinkConfig,
): { origin: string; basePath: string } | undefined {
  if (cfg?.gateway?.controlUi?.enabled === false) {
    return undefined;
  }
  const origin = resolveGatewayPublicOrigin(cfg);
  if (!origin) {
    return undefined;
  }
  return {
    origin,
    basePath: normalizeControlUiBasePath(cfg?.gateway?.controlUi?.basePath),
  };
}

export function resolveControlUiSessionLinkBase(cfg: ControlUiLinkConfig): string | undefined {
  // Session tool descriptions advertise links only when the operator exposes
  // a public Gateway origin and the Control UI can serve those session routes.
  const location = resolveControlUiLinkLocation(cfg);
  if (!location) {
    return undefined;
  }
  const sessionLinkBase = `${location.origin}${location.basePath}`;
  // Model-context budget: bound every model-visible injection at its producer.
  // Omit oversized bases because truncation would produce incorrect URLs.
  return sessionLinkBase.length <= 200 ? sessionLinkBase : undefined;
}

export function resolveControlUiAutomationRunUrl(
  cfg: ControlUiLinkConfig,
  params: { jobId: string; runId?: string },
): string | undefined {
  const location = resolveControlUiLinkLocation(cfg);
  if (!location) {
    return undefined;
  }
  const query = new URLSearchParams({ job: params.jobId });
  if (params.runId) {
    query.set("run", params.runId);
  }
  return `${location.origin}${location.basePath}/automations?${query}`;
}

export function resolveControlUiSessionUrl(
  cfg: ControlUiLinkConfig,
  params: {
    sessionKey?: string;
    fallbackAgentId?: string;
    exactKey?: boolean;
  },
): string | undefined {
  const location = resolveControlUiLinkLocation(cfg);
  if (!location) {
    return undefined;
  }
  const path = buildControlUiSessionPath({
    namespace: "chat",
    sessionKey: params.sessionKey ?? "",
    fallbackAgentId: params.fallbackAgentId,
    basePath: location.basePath,
    exactKey: params.exactKey,
  });
  if (!path) {
    return undefined;
  }
  const url = new URL(location.origin);
  url.pathname = path;
  return url.toString();
}
