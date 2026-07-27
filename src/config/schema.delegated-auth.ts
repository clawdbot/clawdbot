export const DELEGATED_AUTH_FIELD_HELP: Record<string, string> = {
  "plugins.entries.*.auth":
    "Per-plugin auth policy controls for token-bearing runtime capabilities. Keep unset unless the plugin is trusted to receive delegated user credentials.",
  "plugins.entries.*.auth.delegatedAccess":
    "Controls whether this plugin's tools may receive runtime delegated user access tokens through `ctx.auth`. This is separate from `tools.allow`, which only controls tool availability.",
  "plugins.entries.*.auth.delegatedAccess.enabled":
    "Explicitly allows this plugin's tools to request delegated user access tokens at runtime. Keep false unless the plugin is trusted to handle bearer tokens.",
  "plugins.entries.*.auth.delegatedAccess.providers":
    "Optional delegated auth provider allowlist for this plugin. Provider ids are supplied by the active channel runtime; for Teams, use `msteams`.",
  "plugins.entries.*.auth.delegatedAccess.audiences":
    "Optional token audience allowlist for this plugin. Use this to require one of these audiences before OpenClaw releases a delegated token.",
  "plugins.entries.*.auth.delegatedAccess.scopes":
    "Optional delegated scope allowlist for this plugin. Use this to require every requested scope to be listed here before OpenClaw releases a delegated token.",
  "plugins.entries.*.auth.delegatedAccess.chatTypes":
    "Optional chat type allowlist for this plugin. Use this to restrict delegated token release to trusted direct, group, or channel conversations.",
  "plugins.entries.*.hooks":
    "Per-plugin typed hook policy controls for core-enforced safety gates. Use this to constrain high-impact hook categories without disabling the entire plugin.",
  "plugins.entries.*.hooks.allowPromptInjection":
    "Controls whether this plugin may mutate prompts through typed hooks. Set false to block `before_prompt_build` and ignore prompt-mutating fields from legacy `before_agent_start`, while preserving legacy `modelOverride` and `providerOverride` behavior.",
};

export const DELEGATED_AUTH_FIELD_LABELS: Record<string, string> = {
  "plugins.entries.*.auth": "Plugin Auth Policy",
  "plugins.entries.*.auth.delegatedAccess": "Plugin Delegated Auth Policy",
  "plugins.entries.*.auth.delegatedAccess.enabled": "Allow Plugin Delegated Auth",
  "plugins.entries.*.auth.delegatedAccess.providers": "Plugin Delegated Auth Providers",
  "plugins.entries.*.auth.delegatedAccess.audiences": "Plugin Delegated Auth Audiences",
  "plugins.entries.*.auth.delegatedAccess.scopes": "Plugin Delegated Auth Scopes",
  "plugins.entries.*.auth.delegatedAccess.chatTypes": "Plugin Delegated Auth Chat Types",
  "plugins.entries.*.hooks": "Plugin Hook Policy",
};
