// Openai API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { decodeOpenAICodexJwtPayload } from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_API_KEY_LABEL = "OpenAI API Key";
const OPENAI_CHATGPT_LOGIN_LABEL = "ChatGPT Login";
const OPENAI_CHATGPT_LOGIN_HINT = "Sign in with your ChatGPT or Codex subscription";
const OPENAI_CHATGPT_DEVICE_PAIRING_LABEL = "ChatGPT Device Pairing";
const OPENAI_CHATGPT_DEVICE_PAIRING_HINT =
  "Pair your ChatGPT account in browser with a device code";
const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "ChatGPT/Codex sign-in or API key",
} as const;

function accountSubject(access: string): { accountId: string; userId: string } | undefined {
  const claims = asNonArrayRecord(
    decodeOpenAICodexJwtPayload(access)?.["https://api.openai.com/auth"],
  );
  const accountId = normalizeOptionalString(claims.chatgpt_account_id);
  const userId =
    normalizeOptionalString(claims.chatgpt_user_id) ?? normalizeOptionalString(claims.user_id);
  return accountId && userId ? { accountId, userId } : undefined;
}

const matchesPersonalAccount: NonNullable<
  ProviderPlugin["auth"][number]["matchesPersonalAccount"]
> = (credential, existing) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== "openai" ||
    existing.provider !== credential.provider
  ) {
    return false;
  }
  // A ChatGPT account is a workspace, not a person. Reconnect also requires
  // the exact user; missing claims must not replace any owned credential.
  const subject = accountSubject(credential.access);
  const previous = accountSubject(existing.access);
  return Boolean(
    subject && previous?.accountId === subject.accountId && previous.userId === subject.userId,
  );
};

export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: OPENAI_CHATGPT_LOGIN_LABEL,
        hint: OPENAI_CHATGPT_LOGIN_HINT,
        run: noopAuth,
        matchesPersonalAccount,
        wizard: {
          choiceId: "openai",
          choiceLabel: OPENAI_CHATGPT_LOGIN_LABEL,
          choiceHint: OPENAI_CHATGPT_LOGIN_HINT,
          assistantPriority: -40,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "device-code",
        kind: "device_code",
        label: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
        hint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
        run: noopAuth,
        matchesPersonalAccount,
        wizard: {
          choiceId: "openai-device-code",
          choiceLabel: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
          choiceHint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
          assistantPriority: -10,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "api-key",
        kind: "api_key",
        label: OPENAI_API_KEY_LABEL,
        hint: "Use your OpenAI API key directly",
        run: noopAuth,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: OPENAI_API_KEY_LABEL,
          choiceHint: "Use your OpenAI API key directly",
          assistantPriority: 5,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
    ],
  };
}
