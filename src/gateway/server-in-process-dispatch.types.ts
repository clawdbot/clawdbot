import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";

export type GatewayMethodDispatchResponse = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
  meta?: Record<string, unknown>;
};
