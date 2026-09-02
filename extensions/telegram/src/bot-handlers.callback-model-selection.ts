import { randomUUID } from "node:crypto";
import { applySessionModelSelection } from "openclaw/plugin-sdk/model-session-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import type { TelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import * as modelSupport from "./bot-handlers.callback-model.js";
import {
  type TelegramCallbackMessageRuntime,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-router-controls.js";
import type { ResolveTelegramSessionStateParams } from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { type ParsedModelCallback, resolveModelSelection } from "./model-buttons.js";

export async function applyTelegramModelCallbackSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" | "select-ref" }>;
  expectedSelection: { provider: string; model: string };
  chatId: number;
  isGroup: boolean;
  threadSpec: ResolveTelegramSessionStateParams["threadSpec"];
  botHasTopicsEnabled: boolean;
  senderId: string;
  telegramDeps: RegisterTelegramHandlerParams["telegramDeps"];
  messageRuntime: Pick<TelegramCallbackMessageRuntime, "resolveTelegramSessionState">;
  editMessageWithButtons: TelegramCallbackMessageActions["editCallbackMessageWithButtons"];
  reauthorizeCallback: () => Promise<boolean>;
}): Promise<void> {
  const {
    callback,
    expectedSelection,
    chatId,
    isGroup,
    threadSpec,
    botHasTopicsEnabled,
    senderId,
    telegramDeps,
    messageRuntime,
    editMessageWithButtons,
    reauthorizeCallback,
  } = params;

  // Opaque callbacks resolve against a catalog asynchronously. Rebuild the routed
  // session and its model policy from the current runtime snapshot after that await
  // so a model revoked while catalog work was in flight cannot be committed.
  const runtimeCfg = telegramDeps.getRuntimeConfig();
  const resolveCurrentSessionState = () =>
    messageRuntime.resolveTelegramSessionState({
      chatId,
      isGroup,
      threadSpec,
      botHasTopicsEnabled,
      senderId,
      runtimeCfg,
    });
  const initialSessionState = resolveCurrentSessionState();
  const modelData = await modelSupport.retry(async () => {
    return await telegramDeps.buildModelsProviderData(runtimeCfg, initialSessionState.agentId);
  });
  const rejectChangedRoute = async (
    sessionState: ReturnType<typeof resolveCurrentSessionState>,
  ): Promise<boolean> => {
    if (
      sessionState.agentId === initialSessionState.agentId &&
      sessionState.sessionKey === initialSessionState.sessionKey &&
      sessionState.storePath === initialSessionState.storePath
    ) {
      return false;
    }
    await modelSupport.retry(() =>
      editMessageWithButtons(
        "❌ Model routing changed while this selection was loading. Reopen /model and try again.",
        [],
      ),
    );
    return true;
  };
  let sessionState = resolveCurrentSessionState();
  if (await rejectChangedRoute(sessionState)) {
    return;
  }
  const selection = resolveModelSelection({
    callback,
    providers: modelData.providers,
    byProvider: modelData.byProvider,
  });
  if (
    selection.kind !== "resolved" ||
    selection.provider !== expectedSelection.provider ||
    selection.model !== expectedSelection.model ||
    !modelData.byProvider.get(selection.provider)?.has(selection.model)
  ) {
    await modelSupport.retry(() =>
      editMessageWithButtons(
        "❌ This model is no longer available. Reopen /model and try again.",
        [],
      ),
    );
    return;
  }

  const rejectChangedSnapshot = async (): Promise<boolean> => {
    // Runtime snapshots are pinned by identity until replacement. If one changed
    // during final resolution, fail closed rather than applying stale policy.
    if (telegramDeps.getRuntimeConfig() === runtimeCfg) {
      return false;
    }
    await modelSupport.retry(() =>
      editMessageWithButtons(
        "❌ Model settings changed while this selection was loading. Reopen /model and try again.",
        [],
      ),
    );
    return true;
  };
  if (await rejectChangedSnapshot()) {
    return;
  }

  try {
    if (!(await reauthorizeCallback())) {
      logVerbose(
        `Blocked telegram model callback from ${senderId || "unknown"} (authorization revoked before session update)`,
      );
      return;
    }
    if (await rejectChangedSnapshot()) {
      return;
    }
    sessionState = resolveCurrentSessionState();
    if (await rejectChangedRoute(sessionState)) {
      return;
    }
    const storePath = sessionState.storePath;
    const resolvedDefault = resolveDefaultModelForAgent({
      cfg: runtimeCfg,
      agentId: sessionState.agentId,
    });
    const isDefaultSelection =
      selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;
    const persistedSessionEntry =
      sessionState.sessionEntry ??
      telegramDeps.getSessionEntry?.({ storePath, sessionKey: sessionState.sessionKey }) ??
      getSessionEntry({ storePath, sessionKey: sessionState.sessionKey });
    const sessionEntryMissing = persistedSessionEntry === undefined;
    const sessionEntry = persistedSessionEntry ?? {
      sessionId: randomUUID(),
      updatedAt: Date.now(),
    };
    const previousAuthProfileId = sessionEntry.authProfileOverride?.trim();
    const sessionStore = { [sessionState.sessionKey]: sessionEntry };
    const currentModelRef = sessionState.model?.trim();
    const currentModelSeparator = currentModelRef?.indexOf("/") ?? -1;
    const currentProvider =
      currentModelRef && currentModelSeparator > 0
        ? currentModelRef.slice(0, currentModelSeparator)
        : resolvedDefault.provider;
    const currentModel =
      currentModelRef && currentModelSeparator > 0
        ? currentModelRef.slice(currentModelSeparator + 1)
        : resolvedDefault.model;
    const applied = await modelSupport.retry(() =>
      applySessionModelSelection({
        cfg: runtimeCfg,
        agentId: sessionState.agentId,
        sessionKey: sessionState.sessionKey,
        storePath,
        sessionEntry,
        sessionStore,
        allowCreate: sessionEntryMissing,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
        currentProvider,
        currentModel,
        modelCatalog: modelData.modelCatalog,
        canPersistStickyModelSelection: false,
        request: {
          provider: selection.provider,
          model: selection.model,
          isDefault: isDefaultSelection,
          runtime: { kind: "unchanged" },
        },
        markLiveSwitchPending: true,
      }),
    );
    if (applied.status !== "applied") {
      await editMessageWithButtons(`❌ ${applied.message}`, []);
      return;
    }
    const defaultAuthProfileNotice =
      isDefaultSelection && previousAuthProfileId
        ? sessionStore[sessionState.sessionKey]?.authProfileOverride?.trim() ===
          previousAuthProfileId
          ? "Compatible auth profile retained."
          : "Incompatible auth profile cleared."
        : undefined;
    const actionText = isDefaultSelection
      ? "reset to default"
      : `changed to <b>${modelSupport.escapeHtml(selection.provider)}/${modelSupport.escapeHtml(selection.model)}</b>`;
    const runtimeText =
      applied.runtimeChange?.kind === "clear"
        ? `Incompatible session runtime reset to <b>${modelSupport.escapeHtml(applied.agentRuntime)}</b> from configured policy.`
        : `Session runtime remains <b>${modelSupport.escapeHtml(applied.agentRuntime)}</b>.`;
    const scopeText = isDefaultSelection
      ? `Session model selection cleared.${defaultAuthProfileNotice ? ` ${defaultAuthProfileNotice}` : ""} ${runtimeText} New replies use the agent's configured default.`
      : `Session-only model selection. ${runtimeText} The agent default in openclaw.json is unchanged. This chat keeps the model selection across /new and /reset; use /model default -s to clear the session model selection.`;
    await editMessageWithButtons(`✅ Model ${actionText}\n\n${scopeText}`, [], {
      parse_mode: "HTML",
    });
  } catch (err) {
    if (err instanceof TelegramRetryableCallbackError) {
      throw err;
    }
    await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
  }
}
