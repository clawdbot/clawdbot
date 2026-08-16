import { recoverInstalledLaunchAgentAfterUpdate } from "./update-command-launch-agent-recovery.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  hasLoadedLaunchdKeepAliveSupervisor,
  recoverLaunchAgentAndRecheckGatewayHealth,
  shouldUseLegacyProcessRestartAfterUpdate,
} from "./update-command-service-recovery.js";

export const testing = {
  formatPostUpdateGatewayRecoveryInstructions,
  recoverInstalledLaunchAgentAfterUpdate,
  recoverLaunchAgentAndRecheckGatewayHealth,
  hasLoadedLaunchdKeepAliveSupervisor,
  shouldUseLegacyProcessRestartAfterUpdate,
};
