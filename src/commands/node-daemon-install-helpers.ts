/** Node-based daemon install plan builder for managed gateway services. */
import { formatNodeServiceDescription } from "../daemon/constants.js";
import { resolveNodeProgramArguments } from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
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
  };
}

/** Builds launch arguments, environment, and metadata for a Node daemon service install. */
export async function buildNodeInstallPlan(params: {
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<NodeInstallPlan> {
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    host: params.host,
    port: params.port,
    contextPath: params.contextPath,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
    nodeId: params.nodeId,
    displayName: params.displayName,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
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
    // Match the gateway install path so supervised node services keep the chosen
    // node toolchain on PATH for sibling binaries like npm/pnpm when needed.
    extraPathDirs: resolveDaemonNodeBinDir(nodePath),
  });
  const description = formatNodeServiceDescription({
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return {
    programArguments,
    workingDirectory,
    environment,
    environmentValueSources: buildNodeInstallEnvironmentValueSources(),
    description,
  };
}
