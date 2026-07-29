import { t } from "../../i18n/index.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

type ChatModelSetupState = {
  catalog: boolean;
  connected: boolean;
  agentsLoaded: boolean;
  selectedAgentFound: boolean;
  agentModel?: string | null;
};

export function requiresChatModelSetup(state: ChatModelSetupState): boolean {
  if (state.catalog || !state.connected || !state.agentsLoaded || !state.selectedAgentFound) {
    return false;
  }
  return !state.agentModel?.trim();
}

export function createChatModelSetupBanner(onAction: () => void): ChatComposerDisabledBanner {
  return {
    kind: "composer-replacement",
    text: t("modelSetup.required.body"),
    actionLabel: t("modelSetup.required.action"),
    onAction,
  };
}
