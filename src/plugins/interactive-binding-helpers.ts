/** Helpers for binding interactive plugin handlers to conversations and sessions. */
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import type { PluginConversationBindingRequestParams } from "./types.js";

type RegisteredInteractiveMetadata = {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type PluginBindingConversation = Parameters<
  typeof requestPluginConversationBinding
>[0]["conversation"];

export function createInteractiveConversationBindingHelpers(params: {
  registration: RegisteredInteractiveMetadata;
  senderId?: string;
  conversation: PluginBindingConversation;
}) {
  const { registration, senderId, conversation } = params;
  const pluginRoot = registration.pluginRoot;

  return {
    requestConversationBinding: async (binding: PluginConversationBindingRequestParams = {}) => {
      if (!pluginRoot) {
        return {
          status: "error" as const,
          message: "This interaction cannot bind the current conversation.",
        };
      }
      return requestPluginConversationBinding({
        pluginId: registration.pluginId,
        pluginName: registration.pluginName,
        pluginRoot,
        requestedBySenderId: senderId,
        conversation,
        binding,
      });
    },
    detachConversationBinding: async () => {
      if (!pluginRoot) {
        return { removed: false };
      }
      return detachPluginConversationBinding({
        pluginRoot,
        conversation,
      });
    },
    getCurrentConversationBinding: async () => {
      if (!pluginRoot) {
        return null;
      }
      return getCurrentPluginConversationBinding({
        pluginRoot,
        conversation,
      });
    },
  };
}
