/**
 * Sandbox context fixture builder for agent-tool tests.
 *
 * Produces Docker-shaped contexts with safe defaults and caller-controlled filesystem bridges.
 */
import type { SandboxContext, SandboxToolPolicy, SandboxWorkspaceAccess } from "../sandbox.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";

type AgentToolsSandboxContextParams = {
  workspaceDir: string;
  agentWorkspaceDir?: string;
  workspaceAccess?: SandboxWorkspaceAccess;
  skillsWorkspaceDir?: string;
  fsBridge?: SandboxFsBridge;
  tools?: SandboxToolPolicy;
  browserAllowHostControl?: boolean;
  sessionKey?: string;
  containerName?: string;
  containerWorkdir?: string;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
};

/** Builds a Docker-shaped sandbox context with safe test defaults. */
export function createAgentToolsSandboxContext(
  params: AgentToolsSandboxContextParams,
): SandboxContext {
  const workspaceDir = params.workspaceDir;
  return {
    enabled: true,
    backendId: "docker",
    sessionKey: params.sessionKey ?? "sandbox:test",
    workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? workspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workspaceAccess: params.workspaceAccess ?? "rw",
    runtimeId: params.containerName ?? "openclaw-sbx-test",
    runtimeLabel: params.containerName ?? "openclaw-sbx-test",
    containerName: params.containerName ?? "openclaw-sbx-test",
    containerWorkdir: params.containerWorkdir ?? "/workspace",
    fsBridge: params.fsBridge,
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      user: "1000:1000",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      ...params.dockerOverrides,
    },
    tools: params.tools ?? { allow: [], deny: [] },
    browserAllowHostControl: params.browserAllowHostControl ?? false,
  };
}
