import type {
  SessionsObserverAskResult,
  SessionsObserverVisibilityResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export function requestSessionObserverAnswer(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  question: string,
): Promise<SessionsObserverAskResult> {
  return client.request<SessionsObserverAskResult>("sessions.observer.ask", {
    sessionKey,
    question,
  });
}

export function sendSessionObserverVisibility(
  client: Pick<GatewayBrowserClient, "request">,
  visible: boolean,
): Promise<SessionsObserverVisibilityResult> {
  return client.request<SessionsObserverVisibilityResult>("sessions.observer.visibility", {
    visible,
  });
}
