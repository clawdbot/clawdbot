export const OPENAI_API_KEY_LABEL = "OpenAI API Key";
export const OPENAI_CODEX_LOGIN_LABEL = "OpenAI Codex Browser Login";
export const OPENAI_CODEX_LOGIN_HINT = "Sign in with OpenAI in your browser";
export const OPENAI_CODEX_DEVICE_PAIRING_LABEL = "OpenAI Codex Device Pairing";
export const OPENAI_CODEX_DEVICE_PAIRING_HINT = "Pair in browser with a device code";

export const OPENAI_API_KEY_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "Direct API key",
} as const;

export const OPENAI_CODEX_WIZARD_GROUP = {
  groupId: "openai-codex",
  groupLabel: "OpenAI Codex",
  groupHint: "ChatGPT/Codex sign-in",
} as const;
