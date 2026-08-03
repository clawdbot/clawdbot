// Route-first machine-readable Gateway health command.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

type GatewayHealthRpcOpts = Parameters<
  typeof import("../gateway-rpc.js").callGatewayFromCliWithTransport
>[1];

type GatewayHealthJsonRouteArgs = {
  rpc: GatewayHealthRpcOpts;
  localPortOverride?: number;
};

type GatewayHealthRouteDependencies = {
  callGateway?: typeof import("../gateway-rpc.js").callGatewayFromCliWithTransport;
  readBestEffortConfig?: () => Promise<OpenClawConfig>;
  emitReachableGatewayAuthDiagnostic?: typeof import("../../commands/health.js").emitReachableGatewayAuthDiagnostic;
  formatGatewayAuthErrorJson?: typeof import("../../gateway/call.js").formatGatewayAuthErrorJson;
  formatGatewayClientRequestErrorJson?: typeof import("../../gateway/call.js").formatGatewayClientRequestErrorJson;
  formatGatewayTransportErrorJson?: typeof import("../../gateway/call.js").formatGatewayTransportErrorJson;
};

async function resolveRouteRpcOptions(
  args: GatewayHealthJsonRouteArgs,
  deps: GatewayHealthRouteDependencies,
): Promise<GatewayHealthRpcOpts> {
  if (args.localPortOverride === undefined) {
    return args.rpc;
  }
  const readBestEffortConfig =
    deps.readBestEffortConfig ??
    (await import("../../config/read-best-effort-config.runtime.js")).readBestEffortConfig;
  const config = await readBestEffortConfig();
  return {
    ...args.rpc,
    localPortOverride: args.localPortOverride,
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        mode: "local",
        port: args.localPortOverride,
      },
    },
  };
}

/** Run the successful JSON path without loading text presentation modules. */
export async function runGatewayHealthJsonRoute(
  args: GatewayHealthJsonRouteArgs,
  runtime: RuntimeEnv,
  deps: GatewayHealthRouteDependencies = {},
): Promise<void> {
  let rpc: GatewayHealthRpcOpts | undefined;
  try {
    rpc = await resolveRouteRpcOptions(args, deps);
    const callGateway =
      deps.callGateway ?? (await import("../gateway-rpc.js")).callGatewayFromCliWithTransport;
    writeRuntimeJson(
      runtime,
      await callGateway("health", rpc, undefined, { defaultTimeoutMs: 10_000 }),
    );
  } catch (error) {
    if (!rpc) {
      runtime.error(String(error));
      runtime.exit(1);
      return;
    }
    const [healthModule, configModule, callModule] = await Promise.all([
      deps.emitReachableGatewayAuthDiagnostic ? undefined : import("../../commands/health.js"),
      deps.readBestEffortConfig
        ? undefined
        : import("../../config/read-best-effort-config.runtime.js"),
      deps.formatGatewayAuthErrorJson &&
      deps.formatGatewayClientRequestErrorJson &&
      deps.formatGatewayTransportErrorJson
        ? undefined
        : import("../../gateway/call.js"),
    ]);
    const emitReachableGatewayAuthDiagnostic =
      deps.emitReachableGatewayAuthDiagnostic ?? healthModule?.emitReachableGatewayAuthDiagnostic;
    const readBestEffortConfig = deps.readBestEffortConfig ?? configModule?.readBestEffortConfig;
    if (!emitReachableGatewayAuthDiagnostic || !readBestEffortConfig) {
      throw error;
    }
    const handled = await emitReachableGatewayAuthDiagnostic({
      error,
      config: rpc.config ?? (await readBestEffortConfig()),
      runtime,
      timeoutMs: Number(rpc.timeout ?? "10000"),
      token: rpc.token,
      password: rpc.password,
      localPortOverride: rpc.localPortOverride,
      json: true,
    });
    if (handled) {
      return;
    }
    const formatGatewayAuthErrorJson =
      deps.formatGatewayAuthErrorJson ?? callModule?.formatGatewayAuthErrorJson;
    const formatGatewayClientRequestErrorJson =
      deps.formatGatewayClientRequestErrorJson ?? callModule?.formatGatewayClientRequestErrorJson;
    const formatGatewayTransportErrorJson =
      deps.formatGatewayTransportErrorJson ?? callModule?.formatGatewayTransportErrorJson;
    const payload =
      formatGatewayAuthErrorJson?.(error) ??
      formatGatewayClientRequestErrorJson?.(error) ??
      formatGatewayTransportErrorJson?.(error);
    if (payload) {
      writeRuntimeJson(runtime, payload);
      runtime.exit(1);
      return;
    }
    throw error;
  }
}
