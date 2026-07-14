import type { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramApprovalCallback } from "./approval-callback-data.js";
import {
  buildTelegramCanonicalApprovalTerminalText,
  buildTelegramInvalidApprovalTerminalText,
  buildTelegramLegacyApprovalTerminalText,
} from "./approval-terminal.js";
import type { TelegramCallbackMessageActions } from "./bot-handlers.callback-actions.runtime.js";
import {
  isApprovalAlreadyResolvedError,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-errors.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  resolveTelegramApproval,
  resolveTelegramLegacyApproval,
} from "./exec-approval-resolver.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
} from "./exec-approvals.js";

type LegacyApprovalCallback = NonNullable<ReturnType<typeof parseExecApprovalCommandText>>;

export function createTelegramCallbackApprovalRuntime(params: {
  accountId: RegisterTelegramHandlerParams["accountId"];
  telegramDeps: RegisterTelegramHandlerParams["telegramDeps"];
  runtimeCfg: OpenClawConfig;
  senderId: string;
  actions: TelegramCallbackMessageActions;
}) {
  const { accountId, telegramDeps, runtimeCfg, senderId, actions } = params;
  const { clearCallbackButtons, editCallbackMessage, replyToCallbackChat } = actions;

  const resolveApprovalAuthorizations = () => {
    const pluginApprovalAuthorizedSender = isTelegramExecApprovalApprover({
      cfg: runtimeCfg,
      accountId,
      senderId,
    });
    const execApprovalAuthorizedSender = isTelegramExecApprovalAuthorizedSender({
      cfg: runtimeCfg,
      accountId,
      senderId,
    });
    return { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender };
  };

  const clearTerminalApprovalButtons = async () => {
    try {
      // First-answer-wins returns applied:false to losing surfaces. Their controls
      // are stale too, so cleanup follows canonical terminal truth, not local authorship.
      await clearCallbackButtons();
    } catch (editErr) {
      const errStr = String(editErr);
      if (
        errStr.includes("message is not modified") ||
        errStr.includes("there is no text in the message to edit")
      ) {
        return;
      }
      logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
    }
  };

  const terminalizeApprovalMessage = async (text: string) => {
    try {
      await editCallbackMessage(text, { reply_markup: { inline_keyboard: [] } });
      return;
    } catch (editErr) {
      const errStr = String(editErr);
      const alreadyTerminal = errStr.includes("message is not modified");
      if (!alreadyTerminal) {
        logVerbose(`telegram: failed to render terminal approval receipt: ${errStr}`);
      }
      // Preserve the terminal state even when Telegram no longer permits a text edit.
      await clearTerminalApprovalButtons();
      if (alreadyTerminal) {
        return;
      }
    }
    try {
      await replyToCallbackChat(text);
    } catch (sendErr) {
      logVerbose(`telegram: failed to send terminal approval receipt: ${String(sendErr)}`);
    }
  };

  const resolveCanonicalApproval = async (approvalCallback: TelegramApprovalCallback) =>
    await (telegramDeps.resolveApproval ?? resolveTelegramApproval)({
      cfg: runtimeCfg,
      approvalId: approvalCallback.approvalId,
      approvalKind: approvalCallback.approvalKind,
      decision: approvalCallback.decision,
      senderId,
    });

  const terminalizeCanonicalApproval = async (
    approvalCallback: TelegramApprovalCallback,
    result: Awaited<ReturnType<typeof resolveCanonicalApproval>>,
  ) =>
    await terminalizeApprovalMessage(
      buildTelegramCanonicalApprovalTerminalText({
        result,
        fallbackApprovalId: approvalCallback.approvalId,
      }),
    );

  const handleCanonical = async (approvalCallback: TelegramApprovalCallback): Promise<void> => {
    const { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender } =
      resolveApprovalAuthorizations();
    const authorizedApprovalSender =
      approvalCallback.approvalKind === "plugin"
        ? pluginApprovalAuthorizedSender
        : execApprovalAuthorizedSender || pluginApprovalAuthorizedSender;
    if (!authorizedApprovalSender) {
      logVerbose(
        `Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`,
      );
      return;
    }
    try {
      const result = await resolveCanonicalApproval(approvalCallback);
      if (!result.applied) {
        logVerbose(
          `telegram: approval callback already resolved ${approvalCallback.approvalId} ` +
            `status=${result.approval.status}`,
        );
      }
      await terminalizeCanonicalApproval(approvalCallback, result);
    } catch (resolveErr) {
      logVerbose(
        `telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${String(resolveErr)}`,
      );
      if (isApprovalNotFoundError(resolveErr) || isApprovalAlreadyResolvedError(resolveErr)) {
        await terminalizeApprovalMessage(
          buildTelegramLegacyApprovalTerminalText({
            approvalId: approvalCallback.approvalId,
            outcome: "no-longer-pending",
          }),
        );
        return;
      }
      throw new TelegramRetryableCallbackError(resolveErr);
    }
  };

  const handleMalformedReserved = async (): Promise<void> => {
    const { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender } =
      resolveApprovalAuthorizations();
    if (!execApprovalAuthorizedSender && !pluginApprovalAuthorizedSender) {
      logVerbose(
        `Blocked malformed telegram approval callback from ${senderId || "unknown"} (not authorized)`,
      );
      return;
    }
    logVerbose(`telegram: consumed malformed reserved approval callback from ${senderId}`);
    await terminalizeApprovalMessage(buildTelegramInvalidApprovalTerminalText());
  };

  const handleLegacy = async (approvalCallback: LegacyApprovalCallback): Promise<void> => {
    const { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender } =
      resolveApprovalAuthorizations();
    const approvalKinds: Array<"exec" | "plugin"> = [];
    if (execApprovalAuthorizedSender || pluginApprovalAuthorizedSender) {
      approvalKinds.push("exec");
    }
    if (pluginApprovalAuthorizedSender) {
      approvalKinds.push("plugin");
    }
    if (approvalKinds.length === 0) {
      logVerbose(
        `Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`,
      );
      return;
    }

    const resolveLegacy = telegramDeps.resolveLegacyApproval ?? resolveTelegramLegacyApproval;
    for (const approvalKind of approvalKinds) {
      const canonicalCallback: TelegramApprovalCallback = {
        type: "approval",
        approvalId: approvalCallback.approvalId,
        approvalKind,
        decision: approvalCallback.decision,
      };
      try {
        // Legacy callbacks lack an owner. Probe only adapters this sender may use.
        await resolveLegacy({
          cfg: runtimeCfg,
          approvalId: approvalCallback.approvalId,
          approvalKind,
          decision: approvalCallback.decision,
          senderId,
        });
        await terminalizeApprovalMessage(
          buildTelegramLegacyApprovalTerminalText({
            approvalId: approvalCallback.approvalId,
            decision: approvalCallback.decision,
            outcome: "resolved-here",
          }),
        );
        return;
      } catch (resolveErr) {
        if (isApprovalNotFoundError(resolveErr)) {
          continue;
        }
        if (isApprovalAlreadyResolvedError(resolveErr)) {
          try {
            const result = await resolveCanonicalApproval(canonicalCallback);
            await terminalizeCanonicalApproval(canonicalCallback, result);
          } catch (canonicalError) {
            if (
              !isApprovalNotFoundError(canonicalError) &&
              !isApprovalAlreadyResolvedError(canonicalError)
            ) {
              throw new TelegramRetryableCallbackError(canonicalError);
            }
            logVerbose(
              `telegram: canonical approval lookup failed after stale legacy callback ` +
                `${approvalCallback.approvalId}: ${String(canonicalError)}`,
            );
            await terminalizeApprovalMessage(
              buildTelegramLegacyApprovalTerminalText({
                approvalId: approvalCallback.approvalId,
                outcome: "no-longer-pending",
              }),
            );
          }
          return;
        }
        logVerbose(
          `telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${String(resolveErr)}`,
        );
        throw new TelegramRetryableCallbackError(resolveErr);
      }
    }

    logVerbose(`telegram: approval callback not found ${approvalCallback.approvalId}`);
    if (!pluginApprovalAuthorizedSender) {
      return;
    }
    await terminalizeApprovalMessage(
      buildTelegramLegacyApprovalTerminalText({
        approvalId: approvalCallback.approvalId,
        outcome: "no-longer-pending",
      }),
    );
  };

  return { handleCanonical, handleMalformedReserved, handleLegacy };
}
