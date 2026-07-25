import type { SessionsObserverVisibilityResult } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export function sendSessionObserverVisibility(
  client: Pick<GatewayBrowserClient, "request">,
  visible: boolean,
): Promise<SessionsObserverVisibilityResult> {
  return client.request<SessionsObserverVisibilityResult>("sessions.observer.visibility", {
    visible,
  });
}
