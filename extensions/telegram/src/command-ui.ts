import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { buildCommandsPaginationKeyboard } from "openclaw/plugin-sdk/telegram-command-ui";
import {
  buildBrowseProvidersButton,
  buildModelsKeyboard,
  buildProviderKeyboard,
  type ProviderInfo,
} from "./model-buttons.js";

export { buildCommandsPaginationKeyboard };

export function buildTelegramCommandsListChannelData(params: {
  currentPage: number;
  totalPages: number;
  agentId?: string;
}): ReplyPayload["channelData"] | null {
  if (params.totalPages <= 1) {
    return null;
  }
  return {
    telegram: {
      buttons: buildCommandsPaginationKeyboard(
        params.currentPage,
        params.totalPages,
        params.agentId,
      ),
    },
  };
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  return {
    telegram: {
      buttons: buildProviderKeyboard(params.providers),
    },
  };
}

export function buildTelegramModelsListChannelData(params: {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
}): ReplyPayload["channelData"] | null {
  return {
    telegram: {
      buttons: buildModelsKeyboard(params),
    },
  };
}

export function buildTelegramModelBrowseChannelData(): ReplyPayload["channelData"] {
  return {
    telegram: {
      buttons: buildBrowseProvidersButton(),
    },
  };
}
