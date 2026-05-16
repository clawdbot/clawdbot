export const OPENAI_API_KEY_LABEL = "OpenAI API Key";
export const OPENAI_CHATGPT_LOGIN_LABEL = "ChatGPT Login";
export const OPENAI_CHATGPT_LOGIN_HINT = "Sign in with your ChatGPT or Codex subscription";
export const OPENAI_CHATGPT_DEVICE_PAIRING_LABEL = "ChatGPT Device Pairing";
export const OPENAI_CHATGPT_DEVICE_PAIRING_HINT =
  "Pair your ChatGPT account in browser with a device code";
export const OPENAI_CODEX_API_KEY_BACKUP_LABEL = "OpenAI API Key Backup";
export const OPENAI_CODEX_API_KEY_BACKUP_HINT =
  "Use an OpenAI API key when your Codex subscription is unavailable";
export const OPENAI_CODEX_LOGIN_LABEL = "ChatGPT/Codex Browser Login";
export const OPENAI_CODEX_LOGIN_HINT = "Sign in with OpenAI in your browser";
export const OPENAI_CODEX_DEVICE_PAIRING_LABEL = "ChatGPT/Codex Device Pairing";
export const OPENAI_CODEX_DEVICE_PAIRING_HINT = "Pair in browser with a device code";

const OPENAI_UNIFIED_GROUP_HINT = "ChatGPT/Codex sign-in or API key";

export const OPENAI_API_KEY_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "Direct API key",
} as const;

export const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: OPENAI_UNIFIED_GROUP_HINT,
} as const;

export const OPENAI_CODEX_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: OPENAI_UNIFIED_GROUP_HINT,
} as const;
