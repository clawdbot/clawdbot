// Hot sandbox config mismatches stay live for normal sessions but fail closed for delegation.
import { formatCliCommand } from "../../cli/command-format.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxScope } from "./types.js";

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
