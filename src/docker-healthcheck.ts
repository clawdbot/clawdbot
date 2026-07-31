// Resolves and probes the Gateway port for the official Docker image healthcheck.
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "./config/config.js";
import { resolveGatewayPort } from "./config/paths.js";
import type { OpenClawConfig } from "./config/types.js";
import { readActiveGatewayLockPort } from "./infra/gateway-lock.js";
import { isMainModule } from "./infra/is-main.js";

type DockerHealthcheckPortDeps = {
  env: NodeJS.ProcessEnv;
  getRuntimeConfig: () => OpenClawConfig;
  readActiveGatewayLockPort: (opts: { env: NodeJS.ProcessEnv }) => Promise<number | undefined>;
  resolveGatewayPort: (config: OpenClawConfig, env: NodeJS.ProcessEnv) => number;
};

type DockerHealthcheckDeps = Partial<DockerHealthcheckPortDeps> & {
  fetch?: typeof globalThis.fetch;
};

export async function resolveDockerHealthcheckPort(
  deps: Partial<DockerHealthcheckPortDeps> = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const readActivePort = deps.readActiveGatewayLockPort ?? readActiveGatewayLockPort;

  try {
    // The live lock records CLI --port and is authoritative. Config/env only cover startup
    // before the Gateway has acquired its lock or platforms where the owner cannot be verified.
    const activePort = await readActivePort({ env });
    if (activePort !== undefined) {
      return activePort;
    }
  } catch {
    // A best-effort lock read must not hide a healthy Gateway on the configured port.
  }

  const config = (
    deps.getRuntimeConfig ??
    (() =>
      getRuntimeConfig({
        pin: false,
        skipPluginValidation: true,
        skipShellEnvFallback: true,
      }))
  )();
  return (deps.resolveGatewayPort ?? resolveGatewayPort)(config, env);
}

export async function probeDockerGatewayHealth(deps: DockerHealthcheckDeps = {}): Promise<boolean> {
  try {
    const port = await resolveDockerHealthcheckPort(deps);
    const response = await (deps.fetch ?? globalThis.fetch)(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

if (
  isMainModule({
    currentFile: fileURLToPath(import.meta.url),
  })
) {
  void probeDockerGatewayHealth().then((healthy) => {
    process.exitCode = healthy ? 0 : 1;
  });
}
