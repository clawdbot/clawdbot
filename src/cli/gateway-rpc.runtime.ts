import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { withProgress } from "./progress.js";

type CallGatewayFromCliRuntimeExtra = {
  clientName?: Parameters<typeof callGateway>[0]["clientName"];
  mode?: Parameters<typeof callGateway>[0]["mode"];
  deviceIdentity?: Parameters<typeof callGateway>[0]["deviceIdentity"];
  expectFinal?: boolean;
  progress?: boolean;
  scopes?: Parameters<typeof callGateway>[0]["scopes"];
};

export async function callGatewayFromCliRuntime(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: CallGatewayFromCliRuntimeExtra,
) {
  const showProgress = extra?.progress ?? opts.json !== true;
  return await withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: showProgress,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        deviceIdentity: extra?.deviceIdentity,
        expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
        scopes: extra?.scopes,
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: extra?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
        mode: extra?.mode ?? GATEWAY_CLIENT_MODES.CLI,
      }),
  );
}
