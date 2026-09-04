import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type {
  SandboxBackendHandle,
  SandboxCapabilityRootDiscovery,
} from "./backend-handle.types.js";

/** One bounded discovery snapshot per attempt, shared by skill and MCP consumers. */
export async function discoverSandboxEnvironmentCapabilities(params: {
  backend?: SandboxBackendHandle;
  excludePaths?: readonly string[];
  signal?: AbortSignal;
  warn: (message: string) => void;
}): Promise<SandboxCapabilityRootDiscovery[]> {
  const backend = params.backend;
  const environment = backend?.capabilities?.environment;
  if (
    !backend?.discoverCapabilityRoots ||
    environment?.protocolVersion !== 1 ||
    environment.process !== true ||
    environment.filesystem !== true ||
    environment.capabilityRootDiscovery !== true
  ) {
    return [];
  }
  params.signal?.throwIfAborted();
  try {
    const discoveries = await racePromiseWithAbortSignal(
      backend.discoverCapabilityRoots({
        roots: [
          {
            id: "workspace",
            path: backend.workdir,
            ...(params.excludePaths?.length ? { excludePaths: params.excludePaths } : {}),
          },
        ],
        signal: params.signal,
      }),
      params.signal,
    );
    params.signal?.throwIfAborted();
    for (const discovery of discoveries) {
      for (const warning of discovery.warnings ?? []) {
        params.warn("Sandbox capability discovery: " + warning);
      }
      if (discovery.error) {
        params.warn("Sandbox capability discovery: " + discovery.error);
      }
    }
    return discoveries;
  } catch {
    params.signal?.throwIfAborted();
    params.warn(
      "Sandbox capability discovery failed; inspect the backend and workspace capability files.",
    );
    return [];
  }
}
