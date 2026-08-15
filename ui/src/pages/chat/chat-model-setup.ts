import type { ModelCatalogEntry } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import type { ChatModelCatalogMode } from "./chat-model-catalog.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

type ChatModelSetupState = {
  catalog: boolean;
  connected: boolean;
  agentsLoaded: boolean;
  selectedAgentFound: boolean;
  agentModel?: string | null;
};

type ChatModelCatalogControlState = {
  basePath: string;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelCatalogMode?: ChatModelCatalogMode;
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

export function catalogControlProps(state: ChatModelCatalogControlState) {
  return {
    modelCatalog: state.chatModelCatalog,
    catalogMode: state.chatModelCatalogMode,
    modelSettingsHref:
      state.chatModelCatalogMode === "replace"
        ? pathForRoute("model-providers", state.basePath)
        : undefined,
  };
}
