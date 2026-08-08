// Discord plugin module implements native command model picker apply behavior.
import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
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

function normalizeExpectedRuntime(value: string | undefined): string | undefined {
  const runtime = value?.trim();
  if (!runtime) {
    return undefined;
  }
  return runtime === "auto" || runtime === "default" ? "auto" : runtime;
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
  selectedRuntime?: string;
  preferenceScope: DiscordModelPickerPreferenceScope;
  settleMs: number;
  resolveCurrentModel: (route: ResolvedAgentRoute) => string;
  resolveCurrentRuntime: (route: ResolvedAgentRoute) => string;
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
    const hiddenFinalReply = dispatchResult.hiddenFinalReply;
    const effectiveRoute = dispatchResult.effectiveRoute ?? params.route;
    if (params.settleMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, params.settleMs);
      });
    }

    const effectiveModelRef = params.resolveCurrentModel(effectiveRoute);
    const effectiveRuntime = params.resolveCurrentRuntime(effectiveRoute);
    const currentSelection = `Current selection: ${effectiveModelRef} with runtime ${effectiveRuntime}.`;
    if (hiddenFinalReply?.isError) {
      return {
        status: "rejected",
        noticeMessage: `${hiddenFinalReply.text?.trim()}\n${currentSelection}`,
      };
    }
    const expectedRuntime = normalizeExpectedRuntime(params.selectedRuntime);
    const verified =
      effectiveModelRef === params.resolvedModelRef &&
      (expectedRuntime === undefined || effectiveRuntime === expectedRuntime);
    if (verified) {
      await recordDiscordModelPickerRecentModel({
        scope: params.preferenceScope,
        modelRef: params.resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    return verified
      ? {
          status: "success",
          effectiveModelRef,
          noticeMessage:
            hiddenFinalReply?.text?.trim() || `✅ Model set to ${params.resolvedModelRef}.`,
        }
      : {
          status: "mismatch",
          effectiveModelRef,
          noticeMessage: `⚠️ Tried to set ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""}, but current selection is ${effectiveModelRef} with runtime ${effectiveRuntime}.`,
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
