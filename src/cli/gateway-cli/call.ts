// Progress-wrapped Gateway RPC helper shared by CLI command surfaces.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";
import { withProgress } from "../progress.js";

export type GatewayRpcOpts = {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  timeout?: string | null;
  expectFinal?: boolean;
  json?: boolean;
  localPortOverride?: number;
};

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 10_000;

export const callGatewayCli = async (method: string, opts: GatewayRpcOpts, params?: unknown) => {
  const timeoutMs =
    opts.timeout === null
      ? null
      : parseTimeoutMsWithFallback(opts.timeout, DEFAULT_GATEWAY_RPC_TIMEOUT_MS, {
          invalidType: "error",
        });
  return await withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        config: opts.config,
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        timeoutMs,
        localPortOverride: opts.localPortOverride,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
};
