import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-oauth-runtime";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import type { OpenAIQuicksilverAuth } from "./realtime-quicksilver-wire.js";

export async function resolveOpenAIChatGptSubscriptionAuth(
  params: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  },
  { resolveProviderAuthProfileApiKey }: OpenAIRealtimeHost,
): Promise<Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined> {
  const token = await resolveProviderAuthProfileApiKey({
    provider: "openai",
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileTypes: ["oauth"],
    includeExternalCliAuth: false,
  });
  if (!token) {
    return undefined;
  }
  const accountId = resolveOpenAICodexAuthIdentity({ access: token }).accountId;
  if (!accountId) {
    throw new Error("The selected ChatGPT OAuth profile is missing its account id");
  }
  return { type: "oauth", token, accountId };
}
