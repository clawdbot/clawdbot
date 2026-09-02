import type { PluginEntryConfig } from "../config/types.plugins.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type PluginHookPolicy = PluginEntryConfig["hooks"];

export function resolvePromptInjectionAllowed(policy?: PluginHookPolicy): boolean {
  return policy?.allowPromptInjection !== false;
}

export function resolveConversationAccessAllowed(
  origin: PluginOrigin | "official",
  policy?: PluginHookPolicy,
): boolean {
  return origin === "bundled"
    ? policy?.allowConversationAccess !== false
    : policy?.allowConversationAccess === true;
}
