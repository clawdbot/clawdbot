import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { WORKBOARD_CHANGED_EVENT } from "../lib/workboard/types.ts";

export type GatewayBrowserClient = {
  request: ControlUiHost["request"];
  addEventListener: (listener: (event: { event: string; payload?: unknown }) => void) => () => void;
};

export function createWorkboardClient(host: ControlUiHost): GatewayBrowserClient {
  return {
    request: host.request,
    addEventListener: (listener) =>
      host.onEvent(WORKBOARD_CHANGED_EVENT, (payload) =>
        listener({ event: WORKBOARD_CHANGED_EVENT, payload }),
      ),
  };
}

export function isGatewayRequestError(error: unknown): error is Error & {
  code: string;
  gatewayCode: string;
  details?: unknown;
} {
  // Host and plugin have independent module graphs; constructor identity is not a wire contract.
  return error instanceof Error && "gatewayCode" in error && "code" in error;
}
