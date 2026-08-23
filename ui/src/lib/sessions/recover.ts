import type {
  SessionsRecoverParams,
  SessionsRecoverResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function requestSessionRecovery(
  client: Pick<GatewayBrowserClient, "request">,
  params: SessionsRecoverParams,
): Promise<SessionsRecoverResult> {
  const result = await client.request<SessionsRecoverResult>("sessions.recover", params);
  if (!result?.key?.trim() || !result?.sessionId?.trim()) {
    throw new Error("sessions.recover returned no successor identity");
  }
  return result;
}
