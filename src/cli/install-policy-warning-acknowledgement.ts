import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type {
  InstallPolicyWarningAcknowledgementRequest,
  InstallSafetyOverrides,
} from "../plugins/install-security-scan.types.js";
import { promptText } from "./prompt.js";

function canPromptForInstallPolicyWarning(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function resolveInstallPolicyWarningAcknowledgementCliOptions(params: {
  acknowledgeInstallPolicyWarning?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  allowPrompt?: boolean;
}): Pick<InstallSafetyOverrides, "dangerouslyForceUnsafeInstall" | "onInstallPolicyWarning"> {
  const canPrompt =
    !params.acknowledgeInstallPolicyWarning &&
    params.allowPrompt !== false &&
    canPromptForInstallPolicyWarning();
  return {
    ...(params.dangerouslyForceUnsafeInstall ? { dangerouslyForceUnsafeInstall: true } : {}),
    ...(params.acknowledgeInstallPolicyWarning
      ? {
          onInstallPolicyWarning: async () => ({ status: "approved" as const }),
        }
      : canPrompt
        ? {
            onInstallPolicyWarning: async (request: InstallPolicyWarningAcknowledgementRequest) => {
              const targetName = sanitizeTerminalText(request.targetName);
              const answer = await promptText(
                `type: '${targetName}' to ${request.requestMode} anyway\n> `,
              );
              return answer.trim() === targetName ? { status: "approved" } : { status: "declined" };
            },
          }
        : {}),
  };
}
