import { GatewayRequestError } from "../../api/gateway.ts";

export type ApprovalRequestFailure = {
  kind: "connection" | "unavailable";
  gatewayError: GatewayRequestError | null;
} | null;

export function createRequestFailure(
  kind: NonNullable<ApprovalRequestFailure>["kind"],
  error?: unknown,
): NonNullable<ApprovalRequestFailure> {
  return { kind, gatewayError: error instanceof GatewayRequestError ? error : null };
}
