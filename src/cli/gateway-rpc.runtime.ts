// Runtime gateway RPC helper shared by CLI commands that call the Gateway.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../gateway/call.js";
import { resolveGatewayLocalPortOverride } from "./gateway-port-option.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";
import { withProgress } from "./progress.js";

type CallGatewayFromCliRuntimeExtra = {
  clientName?: Parameters<typeof callGateway>[0]["clientName"];
  mode?: Parameters<typeof callGateway>[0]["mode"];
  deviceIdentity?: Parameters<typeof callGateway>[0]["deviceIdentity"];
  signal?: Parameters<typeof callGateway>[0]["signal"];
  expectFinal?: boolean;
  progress?: boolean;
  scopes?: Parameters<typeof callGateway>[0]["scopes"];
  defaultTimeoutMs?: number;
  timeoutMs?: number | null;
  label?: string;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: Parameters<
    typeof callGateway
  >[0]["requiredStoredDeviceAuthScopes"];
  requireLocalBackendSharedAuth?: boolean;
  sharedStateMode?: Parameters<typeof callGateway>[0]["sharedStateMode"];
};

type GatewayCliTransportRpcOpts = Omit<GatewayRpcOpts, "timeout"> & {
  config?: OpenClawConfig;
  timeout?: string | null;
  localPortOverride?: number;
};

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 30_000;

export async function isImplicitLocalGatewayTargetFromCliRuntime(
  opts: GatewayCliTransportRpcOpts,
): Promise<boolean> {
  return await isImplicitLocalGatewayTarget({
    config: opts.config,
    url: opts.url,
    localPortOverride: resolveGatewayLocalPortOverride(opts),
  });
}

export async function callGatewayFromCliRuntime(
  method: string,
  opts: GatewayCliTransportRpcOpts,
  params?: unknown,
  extra?: CallGatewayFromCliRuntimeExtra,
) {
  const localPortOverride = resolveGatewayLocalPortOverride(opts);
  // Progress is disabled for JSON output so stdout stays parseable.
  const showProgress = extra?.progress ?? opts.json !== true;
  const timeoutMs =
    extra?.timeoutMs !== undefined
      ? extra.timeoutMs
      : opts.timeout === null
        ? null
        : parseTimeoutMsWithFallback(
            opts.timeout,
            extra?.defaultTimeoutMs ?? DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
            { invalidType: "error" },
          );
  return await withProgress(
    {
      label: extra?.label ?? `Gateway ${method}`,
      indeterminate: true,
      enabled: showProgress,
    },
    async () =>
      await callGateway({
        config: opts.config,
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        deviceIdentity: extra?.deviceIdentity,
        expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
        scopes: extra?.scopes,
        useStoredDeviceAuth: extra?.useStoredDeviceAuth,
        requiredStoredDeviceAuthScopes: extra?.requiredStoredDeviceAuthScopes,
        requireLocalBackendSharedAuth: extra?.requireLocalBackendSharedAuth,
        sharedStateMode: extra?.sharedStateMode,
        signal: extra?.signal,
        timeoutMs,
        localPortOverride,
        clientName: extra?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
        mode: extra?.mode ?? GATEWAY_CLIENT_MODES.CLI,
      }),
  );
}
