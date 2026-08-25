// Hot sandbox config mismatches stay live for normal sessions but fail closed for delegation.
import { formatCliCommand } from "../../cli/command-format.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxScope } from "./types.js";

const warnedLegacySharedRuntimes = new Set<string>();

function formatSandboxRecreateHint(params: { scope: SandboxScope; sessionKey: string }) {
  if (params.scope === "session") {
    return formatCliCommand(`openclaw sandbox recreate --session ${params.sessionKey}`);
  }
  if (params.scope === "agent") {
    const agentId = resolveSandboxAgentId(params.sessionKey) ?? "main";
    return formatCliCommand(`openclaw sandbox recreate --agent ${agentId}`);
  }
  return formatCliCommand("openclaw sandbox recreate --all");
}

export function handleHotSandboxConfigMismatch(params: {
  containerName: string;
  requireCurrentConfig?: boolean;
  scope: SandboxScope;
  sessionKey: string;
}) {
  const hint = formatSandboxRecreateHint(params);
  if (params.requireCurrentConfig) {
    throw new Error(
      `Sandbox config changed for ${params.containerName}; restricted dispatch requires the current container config. Recreate first: ${hint}`,
    );
  }
  defaultRuntime.log(
    `Sandbox config changed for ${params.containerName} (recently used). Recreate to apply: ${hint}`,
  );
}

export function assertSharedSandboxRuntimeCreationAllowed(params: {
  containerName: string;
  newRuntimeBlockReason?: string;
}): void {
  if (!params.newRuntimeBlockReason) {
    return;
  }
  throw new Error(
    `Cannot create shared sandbox runtime ${params.containerName}.\n${params.newRuntimeBlockReason}`,
  );
}

export function retainLegacySharedSandboxRuntime(params: {
  containerName: string;
  configMismatch: boolean;
  newRuntimeBlockReason?: string;
  requireCurrentConfig?: boolean;
}): void {
  if (!params.newRuntimeBlockReason) {
    return;
  }
  if (params.configMismatch && params.requireCurrentConfig) {
    throw new Error(
      `Shared sandbox runtime ${params.containerName} does not match the requested workspace mounts, and creating its replacement is blocked.\n${params.newRuntimeBlockReason}`,
    );
  }
  if (warnedLegacySharedRuntimes.has(params.containerName)) {
    return;
  }
  warnedLegacySharedRuntimes.add(params.containerName);
  defaultRuntime.log(
    `Reusing grandfathered shared sandbox runtime ${params.containerName}; automatic replacement is blocked until its workspace configuration is compatible.\n${params.newRuntimeBlockReason}`,
  );
}
