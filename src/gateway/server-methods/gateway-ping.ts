import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestOptions } from "./types.js";

/** One scope-free ACK implementation shared by the transport and its registered descriptor. */
export function handleGatewayPing({
  client,
  respond,
}: Pick<GatewayRequestOptions, "client" | "respond">): void {
  const role = client?.connect.role;
  if (role !== "node" && role !== "operator") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`));
    return;
  }
  respond(true, {});
}
