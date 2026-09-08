import { vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigExternalMutationOptions } from "../lib/config/config-gateway-operations.ts";
import { pushServerUiPrefs } from "./server-prefs.ts";

export type RequestMock = ReturnType<
  typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>
>;

export function configWithPrefs(prefs: Record<string, unknown>) {
  return { ui: { prefs } };
}

export function createServerPrefsWriter(
  request: RequestMock,
  gatewayUrl = "ws://gw",
  connected = true,
  refresh: { ok: true } | { ok: false; error: string } = { ok: true },
  canPatch = true,
): Parameters<typeof pushServerUiPrefs>[0] {
  const client = { request, gatewayUrl, connected } as unknown as GatewayBrowserClient;
  const writer = {
    canPatch,
    state: { client, connected },
    runExternalMutation: async <T>(
      task: (client: GatewayBrowserClient) => Promise<T>,
      options?: RuntimeConfigExternalMutationOptions<T>,
    ) => {
      if (!writer.state.connected) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: "offline",
        };
      }
      if (options?.canDispatch && !options.canDispatch()) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: options.dispatchError ?? "dispatch blocked",
        };
      }
      try {
        return {
          ok: true as const,
          value: await task(client),
          refresh,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          reason: message.includes("config changed since last load")
            ? ("conflict" as const)
            : error instanceof GatewayRequestError &&
                (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN")
              ? ("rejected" as const)
              : ("error" as const),
          error: message,
        };
      }
    },
  };
  return writer;
}
