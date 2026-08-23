import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { ClawHubRiskAcknowledgementRequest } from "../infra/clawhub-install-trust.js";
import { promptText, promptYesNo } from "./prompt.js";

type ClawHubRiskAcknowledgementCliOptions = {
  acknowledgeClawHubRisk?: boolean;
};

function canPromptForClawHubRisk(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function resolveClawHubRiskAcknowledgementCliOptions(params: {
  acknowledgeClawHubRisk?: boolean;
  action: "installing" | "updating";
  allowPrompt?: boolean;
}): ClawHubRiskAcknowledgementCliOptions & {
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => Promise<boolean>;
} {
  return {
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    onClawHubRisk:
      params.acknowledgeClawHubRisk || params.allowPrompt === false || !canPromptForClawHubRisk()
        ? undefined
        : async (request) => {
            const packageName = sanitizeTerminalText(request.packageName);
            const releaseLabel = `${packageName}@${sanitizeTerminalText(request.version)}`;
            if (request.acknowledgementKind === "type-package") {
              const answer = await promptText(
                `type: '${packageName}' to ${params.action === "installing" ? "install" : "update"} anyway\n> `,
              );
              return answer.trim() === packageName;
            }
            return await promptYesNo(
              `${params.action === "installing" ? "Install" : "Update"} ClawHub package "${releaseLabel}" after reviewing the warning above?`,
            );
          },
  };
}
