import { normalizeControlUiBasePath } from "@openclaw/session-url-contract";
import { resolveGatewayPublicOrigin } from "./gateway-public-origin.js";
import type { OpenClawConfig } from "./types.js";

export function resolveControlUiSessionLinkBase(
  cfg: Pick<OpenClawConfig, "gateway"> | null | undefined,
): string | undefined {
  // Session tool descriptions advertise links only when the operator exposes
  // a public Gateway origin and the Control UI can serve those session routes.
  if (cfg?.gateway?.controlUi?.enabled === false) {
    return undefined;
  }
  const origin = resolveGatewayPublicOrigin(cfg);
  if (!origin) {
    return undefined;
  }
  const sessionLinkBase = `${origin}${normalizeControlUiBasePath(cfg?.gateway?.controlUi?.basePath)}`;
  // Model-context budget: bound every model-visible injection at its producer.
  // Omit oversized bases because truncation would produce incorrect URLs.
  return sessionLinkBase.length <= 200 ? sessionLinkBase : undefined;
}
