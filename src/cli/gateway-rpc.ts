// Lazy gateway RPC facade and shared Commander options for CLI subcommands.
import type { Command } from "commander";
import type {
  GatewayClientMode,
  GatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { inheritOptionFromParent } from "./command-options.js";
import { resolveGatewayLocalPortOverride } from "./gateway-port-option.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
export type { GatewayRpcOpts } from "./gateway-rpc.types.js";

type GatewayRpcRuntimeModule = typeof import("./gateway-rpc.runtime.js");

const gatewayRpcRuntimeLoader = createLazyImportLoader<GatewayRpcRuntimeModule>(
  () => import("./gateway-rpc.runtime.js"),
);

async function loadGatewayRpcRuntime(): Promise<GatewayRpcRuntimeModule> {
  // Keep gateway transport/runtime imports out of help and shell completion startup.
  return gatewayRpcRuntimeLoader.load();
}

export function addGatewayClientOptions(cmd: Command, defaults?: { timeoutMs?: number }) {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--port <port>", "Local Gateway port")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 30_000))
    .option("--expect-final", "Wait for final response (agent)", false);
}

export function resolveGatewayRpcOptions<T extends { token?: string; password?: string }>(
  opts: T,
  command?: Command,
): T {
  return {
    ...opts,
    token: opts.token ?? inheritOptionFromParent<string>(command, "token"),
    password: opts.password ?? inheritOptionFromParent<string>(command, "password"),
  };
}

export function resolveGatewayRpcOptionsWithLocalPort<
  T extends Pick<GatewayRpcOpts, "url" | "port" | "token" | "password"> & {
    localPortOverride?: number;
  },
>(opts: T, command?: Command) {
  // Leaf defaults must not hide an explicit port supplied before the subcommand.
  const port = command?.getOptionValueSource("port") === "default" ? undefined : opts.port;
  const rpcOpts = {
    ...resolveGatewayRpcOptions(opts, command),
    port: port ?? inheritOptionFromParent<string>(command, "port"),
  };
  return {
    ...rpcOpts,
    localPortOverride: resolveGatewayLocalPortOverride(rpcOpts),
  };
}

export async function callGatewayFromCli(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: {
    clientName?: GatewayClientName;
    mode?: GatewayClientMode;
    deviceIdentity?: DeviceIdentity | null;
    signal?: AbortSignal;
    expectFinal?: boolean;
    progress?: boolean;
    scopes?: OperatorScope[];
    sharedStateMode?: "read-only";
  },
) {
  return await callGatewayFromCliWithTransport(method, opts, params, extra);
}

/** Resolve whether CLI Gateway options select the implicit local Gateway. */
export async function isImplicitLocalGatewayTargetFromCli(opts: GatewayRpcOpts): Promise<boolean> {
  const runtime = await loadGatewayRpcRuntime();
  return await runtime.isImplicitLocalGatewayTargetFromCliRuntime(opts);
}

/** Local fallback is safe only for unavailable or explicitly supported older local Gateways. */
export async function canFallbackToImplicitLocalGateway(params: {
  config: OpenClawConfig;
  error: unknown;
  legacyMethod?: string;
  legacyAgentId?: boolean;
}): Promise<boolean> {
  const gateway = await import("../gateway/call.js");
  const { isGatewayRpcUnavailableError } = await import("../gateway/transport-error.js");
  const { config, error, legacyMethod, legacyAgentId } = params;
  const isLegacyError =
    legacyMethod !== undefined &&
    gateway.isGatewayClientRequestError(error) &&
    error.gatewayCode === "INVALID_REQUEST" &&
    (error.message === `unknown method: ${legacyMethod}` ||
      (legacyAgentId === true &&
        (error.message === `invalid ${legacyMethod} params: unexpected property agentId` ||
          error.message ===
            `invalid ${legacyMethod} params: at root: unexpected property 'agentId'`)));
  return (
    (gateway.isGatewayCredentialsRequiredError(error) ||
      isGatewayRpcUnavailableError(error) ||
      isLegacyError) &&
    (await gateway.isImplicitLocalGatewayTarget({ config }))
  );
}

/** Internal CLI facade for callers that need transport or auth policy overrides. */
export async function callGatewayFromCliWithTransport<T = Record<string, unknown>>(
  method: string,
  opts: Parameters<GatewayRpcRuntimeModule["callGatewayFromCliRuntime"]>[1],
  params?: unknown,
  extra?: Parameters<GatewayRpcRuntimeModule["callGatewayFromCliRuntime"]>[3],
) {
  const runtime = await loadGatewayRpcRuntime();
  return await runtime.callGatewayFromCliRuntime<T>(method, opts, params, extra);
}
