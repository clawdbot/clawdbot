import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath, updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-runtime";
import type { ButtonInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
import {
  recordDiscordModelPickerRecentModel,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

type DiscordModelPickerSelectionCommand = {
  prompt: string;
  command: ChatCommandDefinition;
  args?: CommandArgs;
};

type DiscordModelPickerApplyResult =
  | { status: "success"; effectiveModelRef: string; noticeMessage: string }
  | { status: "mismatch"; effectiveModelRef: string; noticeMessage: string }
  | { status: "rejected"; noticeMessage: string }
  | { status: "timeout"; noticeMessage: string }
  | { status: "failed"; noticeMessage: string };

async function persistDiscordModelPickerOverride(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  provider: string;
  model: string;
  isDefault: boolean;
}): Promise<boolean> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  let persisted = false;
  await updateSessionStore(storePath, (store) => {
    const entry = store[params.route.sessionKey];
    if (!entry) {
      return;
    }
    persisted =
      applyModelOverrideToSessionEntry({
        entry,
        selection: {
          provider: params.provider,
          model: params.model,
          isDefault: params.isDefault,
        },
        markLiveSwitchPending: true,
      }).updated || persisted;
  });
  return persisted;
}

export async function applyDiscordModelPickerSelection(params: {
  interaction: ButtonInteraction | StringSelectMenuInteraction;
  selectionCommand: DiscordModelPickerSelectionCommand;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  route: ResolvedAgentRoute;
  resolvedModelRef: string;
  selectedProvider: string;
  selectedModel: string;
  defaultProvider: string;
  defaultModel: string;
  preferenceScope: DiscordModelPickerPreferenceScope;
  settleMs: number;
  resolveCurrentModel: (route: ResolvedAgentRoute) => string;
}): Promise<DiscordModelPickerApplyResult> {
  try {
    const dispatchResult = await withTimeout(
      params.dispatchCommandInteraction({
        interaction: params.interaction,
        prompt: params.selectionCommand.prompt,
        command: params.selectionCommand.command,
        commandArgs: params.selectionCommand.args,
        cfg: params.cfg,
        discordConfig: params.discordConfig,
        accountId: params.accountId,
        sessionPrefix: params.sessionPrefix,
        preferFollowUp: true,
        threadBindings: params.threadBindings,
        suppressReplies: true,
      }),
      12000,
    );
    if (!dispatchResult.accepted) {
      return {
        status: "rejected",
        noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`,
      };
    }

    const fallbackRoute = dispatchResult.effectiveRoute ?? params.route;
    if (params.settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, params.settleMs));
    }

    let effectiveModelRef = params.resolveCurrentModel(fallbackRoute);
    let persisted = effectiveModelRef === params.resolvedModelRef;

    if (!persisted) {
      logVerbose(
        `discord: model picker override mismatch — expected ${params.resolvedModelRef} but read ${effectiveModelRef} from session key ${fallbackRoute.sessionKey}; attempting direct session override persist`,
      );
      try {
        const directlyPersisted = await persistDiscordModelPickerOverride({
          cfg: params.cfg,
          route: fallbackRoute,
          provider: params.selectedProvider,
          model: params.selectedModel,
          isDefault:
            params.selectedProvider === params.defaultProvider &&
            params.selectedModel === params.defaultModel,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        effectiveModelRef = params.resolveCurrentModel(fallbackRoute);
        persisted = effectiveModelRef === params.resolvedModelRef;
        if (!persisted) {
          logVerbose(
            `discord: direct session override persist failed — expected ${params.resolvedModelRef} but read ${effectiveModelRef} from session key ${fallbackRoute.sessionKey}`,
          );
        } else if (!directlyPersisted) {
          logVerbose(
            `discord: direct session override persist became a no-op because ${params.resolvedModelRef} was already present on re-read for session key ${fallbackRoute.sessionKey}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logVerbose(
          `discord: direct session override persist threw for session key ${fallbackRoute.sessionKey}: ${message}`,
        );
      }
    }

    if (persisted) {
      await recordDiscordModelPickerRecentModel({
        scope: params.preferenceScope,
        modelRef: params.resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    return persisted
      ? {
          status: "success",
          effectiveModelRef,
          noticeMessage: `✅ Model set to ${params.resolvedModelRef}.`,
        }
      : {
          status: "mismatch",
          effectiveModelRef,
          noticeMessage: `⚠️ Tried to set ${params.resolvedModelRef}, but current model is ${effectiveModelRef}.`,
        };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return {
        status: "timeout",
        noticeMessage: `⏳ Model change to ${params.resolvedModelRef} is still processing. Check /status in a few seconds.`,
      };
    }
    return {
      status: "failed",
      noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`,
    };
  }
}
