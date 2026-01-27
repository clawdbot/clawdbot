import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { resolveSandboxContext } from "../sandbox.js";
import type { EmbeddedSandboxInfo } from "./types.js";

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  execElevated?: ExecElevatedDefaults,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) return undefined;
  const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserBridgeUrl: sandbox.browser?.bridgeUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    ...(elevatedAllowed
      ? {
          elevated: {
            allowed: true,
            defaultLevel: execElevated?.defaultLevel ?? "off",
          },
        }
      : {}),
  };
}
