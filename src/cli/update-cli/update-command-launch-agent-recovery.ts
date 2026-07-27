import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { recoverInstalledLaunchAgent } from "../daemon-cli/launchd-recovery.js";

export type PostUpdateLaunchAgentRecoveryResult =
  | { attempted: false; recovered: false }
  | { attempted: true; recovered: true; message: string }
  | { attempted: true; recovered: false; detail: string };

type PostUpdateLaunchAgentRecoveryDeps = {
  platform?: NodeJS.Platform;
  readState?: typeof readGatewayServiceState;
  recover?: typeof recoverInstalledLaunchAgent;
};

export async function recoverInstalledLaunchAgentAfterUpdate(params: {
  service?: GatewayService;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateLaunchAgentRecoveryDeps;
}): Promise<PostUpdateLaunchAgentRecoveryResult> {
  const platform = params.deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return { attempted: false, recovered: false };
  }

  const service = params.service ?? resolveGatewayService();
  const readState = params.deps?.readState ?? readGatewayServiceState;
  const recover = params.deps?.recover ?? recoverInstalledLaunchAgent;
  const state = await readState(service, { env: params.env }).catch(() => null);
  if (state?.loaded) {
    return { attempted: false, recovered: false };
  }
  if (state && !state.installed && !state.runtime?.missingSupervision) {
    return { attempted: false, recovered: false };
  }

  const recovered = await recover({ result: "restarted", env: state?.env ?? params.env }).catch(
    () => null,
  );
  if (!recovered) {
    return {
      attempted: true,
      recovered: false,
      detail:
        "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
    };
  }

  return {
    attempted: true,
    recovered: true,
    message: recovered.message,
  };
}
