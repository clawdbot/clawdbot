import type { ClawHubRiskAcknowledgementRequest } from "../plugins/clawhub.js";
import { promptYesNo } from "./prompt.js";

export type ClawHubRiskAcknowledgementCliOptions = {
  acknowledgeClawHubRisk?: boolean;
};

function canPromptForClawHubRisk(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function resolveClawHubRiskAcknowledgementCliOptions(params: {
  acknowledgeClawHubRisk?: boolean;
  action: "installing" | "updating";
}): ClawHubRiskAcknowledgementCliOptions & {
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => Promise<boolean>;
} {
  return {
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    onClawHubRisk:
      params.acknowledgeClawHubRisk || !canPromptForClawHubRisk()
        ? undefined
        : async (request) =>
            await promptYesNo(
              `Continue ${params.action} ClawHub package "${request.packageName}@${request.version}" despite this warning?`,
            ),
  };
}
