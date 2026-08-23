import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentTurnContext } from "../agent-turn/types.js";
import { updateChatRunProvider } from "../chat-abort.js";

export function createAgentRunModelSelectionHandler(params: {
  context: Pick<AgentTurnContext, "chatAbortControllers">;
  runId: string;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  restoredCronContinuationLifecycleRevision?: string;
  resolvedSessionKey?: string;
  lifecycleStorePath: string;
  activeSessionAgentId: string;
  trustedInternalHandoff?: { provider: string; model: string };
}): (selection: { provider: string; model: string }) => Promise<void> {
  return async ({ provider, model }) => {
    if (params.trustedInternalHandoff) {
      // The one-use grant remains tied to this run while its active model falls back.
      params.trustedInternalHandoff.provider = provider.trim().toLowerCase();
      params.trustedInternalHandoff.model = model.trim();
    }
    updateChatRunProvider(params.context.chatAbortControllers, {
      runId: params.runId,
      providerId: provider,
      authProviderId: resolveProviderIdForAuth(provider, {
        config: params.cfgForAgent ?? params.cfg,
      }),
    });
    if (!params.restoredCronContinuationLifecycleRevision || !params.resolvedSessionKey) {
      return;
    }
    const persistedSelectedModel = await applySessionEntryReplacements({
      activeSessionKey: params.resolvedSessionKey,
      requireWriteSuccess: true,
      sessionKeys: [params.resolvedSessionKey],
      skipMaintenance: false,
      storePath: params.lifecycleStorePath,
      update: (entries) => {
        const current = entries.find(
          (entry) => entry.sessionKey === params.resolvedSessionKey,
        )?.entry;
        const marker = current?.cronRunContinuation;
        if (
          !current ||
          marker?.phase !== "continuing" ||
          marker.ownerRunId !== params.runId ||
          marker.lifecycleRevision !== params.restoredCronContinuationLifecycleRevision
        ) {
          return { result: false };
        }
        const executionProvider =
          resolveCliRuntimeExecutionProvider({
            provider,
            cfg: params.cfgForAgent ?? params.cfg,
            agentId: params.activeSessionAgentId,
            modelId: model,
          }) ?? provider;
        const cronRunContinuation = { ...marker };
        if (isCliProvider(executionProvider, params.cfgForAgent ?? params.cfg)) {
          cronRunContinuation.cliExecutionProvider = executionProvider;
        } else {
          delete cronRunContinuation.cliExecutionProvider;
        }
        return {
          replacements: [
            {
              sessionKey: params.resolvedSessionKey!,
              entry: {
                ...current,
                cronRunContinuation,
                modelProvider: provider,
                model,
                updatedAt: Date.now(),
              },
            },
          ],
          result: true,
        };
      },
    });
    if (!persistedSelectedModel) {
      throw new Error("cron run continuation changed before model execution");
    }
  };
}
