// Telegram plugin module implements native Codex login behavior.
import type { CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  decideProviderLoginSessionAdoption,
  createProviderLoginFlowRegistry,
  formatProviderLoginChoices,
  formatProviderLoginCommand,
  formatProviderLoginComplete,
  formatProviderLoginControlUiHandoff,
  formatProviderLoginFailed,
  formatProviderLoginSessionSwitchFailed,
  hasConfiguredCommandOwnerAllowlist,
  isProviderLoginPatchPersisted,
  releaseProviderLoginFlow,
  reserveProviderLoginFlow,
  resolveProviderChannelLoginChoice,
  runProviderChannelLoginFlow,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveStorePath,
  updateSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramCommandDispatch } from "./bot-native-command-dispatch.js";
import { buildTelegramRoutingTarget } from "./bot/helpers.js";

const activeTelegramProviderLoginFlows = createProviderLoginFlowRegistry();

type TelegramLoginDeviceCode = {
  title: string;
  code: string;
  expiresInMinutes?: number;
  message?: string;
};

// Telegram's inline-code entity provides the tap-to-copy affordance needed for
// short-lived device codes; plain text and literal backticks do not.
function formatTelegramLoginDeviceCode(params: TelegramLoginDeviceCode): string {
  return [
    `<b>${escapeHtml(params.title)}</b>`,
    "",
    ...(params.message ? [escapeHtml(params.message)] : []),
    `Code: <code>${escapeHtml(params.code)}</code>`,
    ...(params.expiresInMinutes
      ? [`Code expires in ${params.expiresInMinutes} minutes. Never share it.`]
      : []),
  ].join("\n");
}

function resolveTelegramProviderLoginInput(
  commandArgs: CommandArgs | undefined,
): string | undefined {
  const providerValue = commandArgs?.values?.provider;
  return typeof providerValue === "string" && providerValue.trim()
    ? providerValue
    : commandArgs?.raw;
}

function buildTelegramProviderLoginFlowKey(dispatch: TelegramCommandDispatch): string {
  const threadKey =
    dispatch.threadSpec.id == null
      ? dispatch.threadSpec.scope
      : `${dispatch.threadSpec.scope}:${dispatch.threadSpec.id}`;
  return [
    "telegram",
    dispatch.route.accountId,
    String(dispatch.chatId),
    threadKey,
    dispatch.route.agentId,
  ].join(":");
}

export async function executeTelegramLoginCommand(params: {
  dispatch: TelegramCommandDispatch;
  commandArgs?: CommandArgs;
  currentProvider?: string;
}): Promise<boolean> {
  const { dispatch } = params;
  const sendLoginMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () => dispatch.bot.api.sendMessage(dispatch.chatId, text, dispatch.threadParams ?? {}),
    });
  };
  const sendLoginDeviceCode = async (deviceCode: TelegramLoginDeviceCode) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () =>
        dispatch.bot.api.sendMessage(dispatch.chatId, formatTelegramLoginDeviceCode(deviceCode), {
          ...dispatch.threadParams,
          parse_mode: "HTML",
        }),
    });
  };
  const sendLoginResultMessage = async (text: string) => {
    await dispatch.telegramDeps.sendMessageTelegram(
      buildTelegramRoutingTarget(dispatch.chatId, dispatch.threadSpec),
      text,
      {
        cfg: dispatch.runtimeCfg,
        token: dispatch.opts.token,
        accountId: dispatch.route.accountId,
      },
    );
  };
  if (!dispatch.senderIsOwner || !hasConfiguredCommandOwnerAllowlist(dispatch.runtimeCfg)) {
    await sendLoginMessage(
      "Only a configured OpenClaw owner can start provider login from Telegram.",
    );
    return false;
  }
  const resolution = resolveProviderChannelLoginChoice(
    resolveTelegramProviderLoginInput(params.commandArgs),
    { config: dispatch.runtimeCfg },
  );
  if (resolution.status !== "resolved") {
    const available = formatProviderLoginChoices(resolution.choices);
    await sendLoginMessage(
      resolution.status === "ambiguous"
        ? `Choose one provider login: ${available}.`
        : `Unsupported login provider. Available provider access commands: ${available}.`,
    );
    return false;
  }
  const loginChoice = resolution.choice;
  if (dispatch.isGroup) {
    await sendLoginMessage(
      `For safety, provider login codes are only sent in a private chat with this bot. DM this bot \`${formatProviderLoginCommand(loginChoice)}\` to sign in.`,
    );
    return true;
  }
  if (loginChoice.mode !== "chat") {
    await sendLoginMessage(formatProviderLoginControlUiHandoff(loginChoice));
    return true;
  }
  const flowKey = buildTelegramProviderLoginFlowKey(dispatch);
  const reservation = reserveProviderLoginFlow({
    flows: activeTelegramProviderLoginFlows,
    flowKey,
  });
  if (reservation.status === "active") {
    await sendLoginMessage(
      `${loginChoice.providerLabel} login is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.`,
    );
    return true;
  }
  const flowSignal = dispatch.opts.accountAbortSignal
    ? AbortSignal.any([reservation.record.signal, dispatch.opts.accountAbortSignal])
    : reservation.record.signal;
  const deviceCodeDelivered = createDeferred<void>();
  let deviceCodeWasDelivered = false;
  // Device-code delivery releases Telegram's serialized chat lane. The
  // reservation and account signal still own polling through completion.
  const completion = (async () => {
    const sessionSwitchFailedMessage = formatProviderLoginSessionSwitchFailed(
      loginChoice,
      "Telegram session",
    );
    let terminalMessage: string;
    try {
      const targetSessionEntryAtStart = dispatch.nativeCommandRuntime.getSessionEntry({
        agentId: dispatch.route.agentId,
        sessionKey: dispatch.targetSessionKey,
      });
      const loginResult = await runProviderChannelLoginFlow({
        choice: loginChoice,
        agentId: dispatch.route.agentId,
        config: dispatch.runtimeCfg,
        runtime: dispatch.runtime,
        signal: flowSignal,
        sendMessage: sendLoginMessage,
        sendDeviceCode: async (deviceCode) => {
          flowSignal.throwIfAborted();
          await sendLoginDeviceCode(deviceCode);
          flowSignal.throwIfAborted();
          deviceCodeWasDelivered = true;
          deviceCodeDelivered.resolve();
        },
        unsupportedPromptMessage:
          "This provider needs input that Telegram cannot collect. Open Control UI → Models and choose Sign in.",
      });
      flowSignal.throwIfAborted();
      const nextProfileId = loginResult.profiles.find(
        (profile) =>
          normalizeLowercaseStringOrEmpty(profile.provider) ===
          normalizeLowercaseStringOrEmpty(loginChoice.providerId),
      )?.profileId;
      terminalMessage = formatProviderLoginComplete(
        loginChoice,
        loginResult.imported === true,
        loginResult.modelAccess,
        loginResult.authRefresh,
      );
      if (!nextProfileId) {
        terminalMessage = sessionSwitchFailedMessage;
      } else if (
        normalizeLowercaseStringOrEmpty(params.currentProvider) ===
        normalizeLowercaseStringOrEmpty(loginChoice.providerId)
      ) {
        const storePath = resolveStorePath(dispatch.runtimeCfg.session?.store, {
          agentId: dispatch.route.agentId,
        });
        let entryObserved = false;
        let adoptionDecision: ReturnType<typeof decideProviderLoginSessionAdoption> | undefined;
        try {
          const persisted = await updateSessionStoreEntry({
            sessionKey: dispatch.targetSessionKey,
            storePath,
            requireWriteSuccess: true,
            skipMaintenance: true,
            update: (entry) => {
              entryObserved = true;
              if (flowSignal.aborted) {
                return null;
              }
              adoptionDecision = decideProviderLoginSessionAdoption({
                currentModelProvider: params.currentProvider,
                loginProvider: loginChoice.providerId,
                nextProfileId,
                snapshot: targetSessionEntryAtStart,
                current: entry,
              });
              return adoptionDecision.status === "patch" ? adoptionDecision.patch : null;
            },
          });
          flowSignal.throwIfAborted();
          if (
            entryObserved &&
            (adoptionDecision?.status === "rejected" ||
              !persisted ||
              (adoptionDecision?.status === "patch" &&
                !isProviderLoginPatchPersisted(persisted, nextProfileId)))
          ) {
            terminalMessage = sessionSwitchFailedMessage;
          }
        } catch (error) {
          flowSignal.throwIfAborted();
          dispatch.runtime.error?.(
            danger(
              `telegram ${formatProviderLoginCommand(loginChoice)} completed but failed to update session auth profile: ${String(
                error,
              )}`,
            ),
          );
          terminalMessage = sessionSwitchFailedMessage;
        }
      }
    } catch (error) {
      if (flowSignal.aborted) {
        return;
      }
      dispatch.runtime.error?.(
        danger(`telegram ${formatProviderLoginCommand(loginChoice)} failed: ${String(error)}`),
      );
      terminalMessage = formatProviderLoginFailed(loginChoice);
    }
    if (flowSignal.aborted) {
      return;
    }
    try {
      await sendLoginResultMessage(terminalMessage);
    } catch (error) {
      dispatch.runtime.error?.(
        danger(
          `telegram ${formatProviderLoginCommand(loginChoice)} result notification failed: ${String(error)}`,
        ),
      );
    }
  })().finally(() => {
    releaseProviderLoginFlow({
      flows: activeTelegramProviderLoginFlows,
      flowKey,
      record: reservation.record,
    });
  });
  await Promise.race([deviceCodeDelivered.promise, completion]);
  return deviceCodeWasDelivered;
}
