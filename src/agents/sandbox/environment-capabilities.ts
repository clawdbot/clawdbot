import type {
  SandboxEnvironmentCapabilityRootConfig,
  SandboxEnvironmentMcpServerRequirement,
} from "../../config/types.agents-shared.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type {
  SandboxBackendHandle,
  SandboxCapabilityRootDiscovery,
} from "./backend-handle.types.js";

export type SandboxEnvironmentMcpAuthorization = {
  selectionId: string;
  backendId: string;
  runtimeId: string;
  rootPath: string;
  mcpServers: Record<string, SandboxEnvironmentMcpServerRequirement>;
};

export type SandboxEnvironmentCapabilityDiscovery = SandboxCapabilityRootDiscovery & {
  mcpAuthorizations?: readonly SandboxEnvironmentMcpAuthorization[];
};

/** One bounded discovery snapshot per attempt, shared by skill and MCP consumers. */
export async function discoverSandboxEnvironmentCapabilities(params: {
  backend?: SandboxBackendHandle;
  capabilityRoots?: readonly SandboxEnvironmentCapabilityRootConfig[];
  excludePaths?: readonly string[];
  signal?: AbortSignal;
  warn: (message: string) => void;
}): Promise<SandboxEnvironmentCapabilityDiscovery[]> {
  const backend = params.backend;
  const environment = backend?.capabilities?.environment;
  if (
    !backend?.discoverCapabilityRoots ||
    environment?.protocolVersion !== 1 ||
    !environment.process ||
    !environment.filesystem ||
    !environment.capabilityRootDiscovery
  ) {
    return [];
  }
  params.signal?.throwIfAborted();
  try {
    const workspaceRequest = { id: "workspace", path: backend.workdir };
    const discoveries = await racePromiseWithAbortSignal(
      backend.discoverCapabilityRoots({
        roots: [
          {
            ...workspaceRequest,
            ...(params.excludePaths?.length ? { excludePaths: params.excludePaths } : {}),
          },
        ],
        signal: params.signal,
      }),
      params.signal,
    );
    params.signal?.throwIfAborted();
    const validated = discoveries.filter((discovery) => {
      if (discovery.id === workspaceRequest.id && discovery.path === workspaceRequest.path) {
        return true;
      }
      params.warn("Sandbox capability discovery returned an unexpected root; result ignored.");
      return false;
    });
    const mcpAuthorizations = params.capabilityRoots?.map((root) => {
      const mcpServers: SandboxEnvironmentMcpAuthorization["mcpServers"] = {};
      for (const [name, server] of Object.entries(root.mcpServers)) {
        mcpServers[name] = {
          command: server.command,
          ...(server.args ? { args: [...server.args] } : {}),
          ...(server.cwd ? { cwd: server.cwd } : {}),
          ...(server.env ? { env: { ...server.env } } : {}),
        };
      }
      return {
        selectionId: root.id,
        backendId: backend.id,
        runtimeId: backend.runtimeId,
        rootPath: backend.workdir,
        mcpServers,
      };
    });
    for (const discovery of validated) {
      for (const warning of discovery.warnings ?? []) {
        params.warn("Sandbox capability discovery: " + warning);
      }
      if (discovery.error) {
        params.warn("Sandbox capability discovery: " + discovery.error);
      }
    }
    const authorizedDiscoveries: SandboxEnvironmentCapabilityDiscovery[] = [];
    for (const discovery of validated) {
      authorizedDiscoveries.push({
        ...discovery,
        ...(mcpAuthorizations?.length ? { mcpAuthorizations } : {}),
      });
    }
    return authorizedDiscoveries;
  } catch {
    params.signal?.throwIfAborted();
    params.warn(
      "Sandbox capability discovery failed; inspect the backend and workspace capability files.",
    );
    return [];
  }
}
