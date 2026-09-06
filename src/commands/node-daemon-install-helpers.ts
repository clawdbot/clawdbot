/** Managed node-host install plan builder. */
import { OPENCLAW_WRAPPER_ENV_KEY, resolveNodeProgramArguments } from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonRuntimeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

type NodeInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  description?: string;
};

function buildNodeInstallEnvironmentValueSources(): Record<
  string,
  GatewayServiceEnvironmentValueSource | undefined
> {
  return {
    OPENCLAW_GATEWAY_TOKEN: "file",
    OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
    CF_ACCESS_CLIENT_ID: "file",
    CF_ACCESS_CLIENT_SECRET: "file", // pragma: allowlist secret
  };
}

/** Builds launch arguments, environment, and metadata for a managed node-host service install. */
export async function buildNodeInstallPlan(params: {
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  runtimePath?: string;
  wrapperPath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<NodeInstallPlan> {
  const wrapperPath = params.wrapperPath ?? params.env[OPENCLAW_WRAPPER_ENV_KEY];
  const { devMode, runtimePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    runtimePath: params.runtimePath,
    wrapperPath,
  });
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    host: params.host,
    port: params.port,
    contextPath: params.contextPath,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
    nodeId: params.nodeId,
    displayName: params.displayName,
    installedAppsSharing: params.installedAppsSharing,
    dev: devMode,
    runtime: params.runtime,
    runtimePath,
    wrapperPath,
  });

  await emitDaemonInstallRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Node daemon runtime",
  });

  const environment = buildNodeServiceEnvironment({
    env: params.env,
    // Match the Gateway install path so supervised services keep the chosen
    // runtime toolchain on PATH for sibling binaries when needed.
    extraPathDirs: resolveDaemonRuntimeBinDir(runtimePath),
  });
  return {
    programArguments,
    workingDirectory,
    environment,
    environmentValueSources: buildNodeInstallEnvironmentValueSources(),
    description: "OpenClaw Node Host",
  };
}
