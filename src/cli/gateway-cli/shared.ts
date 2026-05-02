import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

function renderGatewayServiceStopHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.OPENCLAW_PROFILE;
  switch (process.platform) {
    case "darwin":
      return [
        `Tip: ${formatCliCommand("openclaw gateway stop")}`,
        `Or: launchctl bootout gui/$UID/${resolveGatewayLaunchAgentLabel(profile)}`,
      ];
    case "linux":
      return [
        `Tip: ${formatCliCommand("openclaw gateway stop")}`,
        `Or: systemctl --user stop ${resolveGatewaySystemdServiceName(profile)}.service`,
      ];
    case "win32":
      return [
        `Tip: ${formatCliCommand("openclaw gateway stop")}`,
        `Or: schtasks /End /TN "${resolveGatewayWindowsTaskName(profile)}"`,
      ];
    default:
      return [`Tip: ${formatCliCommand("openclaw gateway stop")}`];
  }
}

export async function maybeExplainGatewayServiceStop() {
  const service = resolveGatewayService();
  let loaded: boolean | null = null;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = null;
  }
  if (loaded === false) {
    return;
  }
  defaultRuntime.error(
    loaded
      ? `Gateway service appears ${service.loadedText}. Stop it first.`
      : "Gateway service status unknown; if supervised, stop it first.",
  );
  for (const hint of renderGatewayServiceStopHints()) {
    defaultRuntime.error(hint);
  }
}
