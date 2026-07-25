import { createHash } from "node:crypto";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import type { MxcConfig } from "./config.js";
import { createMxcSandboxBackendHandle } from "./mxc-backend.js";

function sanitizeRuntimeId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `openclaw-mxc-${slug || "sandbox"}-${hash}`;
}

/** Factory function called by OpenClaw when sandbox.backend=mxc. */
export function createMxcSandboxBackendFactory(config: MxcConfig) {
  return async function createMxcSandboxBackend(
    params: CreateSandboxBackendParams,
  ): Promise<SandboxBackendHandle> {
    if ((params.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error("MXC sandbox backend does not support sandbox.docker.binds.");
    }
    const runtimeId = sanitizeRuntimeId(params.scopeKey);
    return createMxcSandboxBackendHandle({
      config,
      runtimeId,
      workdir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
      workspaceAccess: params.cfg.workspaceAccess,
    });
  };
}
