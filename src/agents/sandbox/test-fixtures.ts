/**
 * Sandbox test fixture helpers.
 *
 * Builds complete sandbox contexts with Docker defaults so tests can override only the fields under scrutiny.
 */
import type { SandboxContext } from "./types.js";

export function createSandboxTestContext(params?: {
  overrides?: Partial<SandboxContext>;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
}): SandboxContext {
  const overrides = params?.overrides ?? {};
  const { docker: _unusedDockerOverrides, ...sandboxOverrides } = overrides;
  const docker = {
    image: "openclaw-sandbox:bookworm-slim",
    containerPrefix: "openclaw-sbx-",
    network: "none",
    user: "1000:1000",
    workdir: "/workspace",
    readOnlyRoot: false,
    tmpfs: [],
    capDrop: [],
    seccompProfile: "",
    apparmorProfile: "",
    setupCommand: "",
    binds: [],
    dns: [],
    extraHosts: [],
    pidsLimit: 0,
    ...overrides.docker,
    ...params?.dockerOverrides,
  };

  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "sandbox:test",
    workspaceDir: "/tmp/workspace",
    agentWorkspaceDir: "/tmp/workspace",
    workspaceAccess: "rw",
    runtimeId: "openclaw-sbx-test",
    runtimeLabel: "openclaw-sbx-test",
    containerName: "openclaw-sbx-test",
    containerWorkdir: "/workspace",
    tools: { allow: ["*"], deny: [] },
    browserAllowHostControl: false,
    ...sandboxOverrides,
    docker,
  };
}
