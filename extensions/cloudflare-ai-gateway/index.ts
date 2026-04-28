import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  ensureAuthProfileStore,
  listProfilesForProvider,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  upsertAuthProfile,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { buildCloudflareAiGatewayCatalogProvider } from "./catalog-provider.js";
import { CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF } from "./models.js";
import { applyCloudflareAiGatewayConfig, buildCloudflareAiGatewayConfigPatch } from "./onboard.js";
import { wrapCloudflareAiGatewayProviderStream } from "./stream-wrappers.js";

const PROVIDER_ID = "cloudflare-ai-gateway";
const PROVIDER_ENV_VAR = "CLOUDFLARE_AI_GATEWAY_API_KEY";
const PROFILE_ID = "cloudflare-ai-gateway:default";

function readRequiredTextInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveCloudflareGatewayMetadataInteractive(ctx: {
  accountId?: string;
  gatewayId?: string;
  prompter: {
    text: (params: {
      message: string;
      validate?: (value: unknown) => string | undefined;
    }) => Promise<unknown>;
  };
}) {
  let accountId = normalizeOptionalString(ctx.accountId) ?? "";
  let gatewayId = normalizeOptionalString(ctx.gatewayId) ?? "";
  if (!accountId) {
    const value = await ctx.prompter.text({
      message: "Enter Cloudflare Account ID",
      validate: (val) => (readRequiredTextInput(val) ? undefined : "Account ID is required"),
    });
    accountId = readRequiredTextInput(value);
  }
  if (!gatewayId) {
    const value = await ctx.prompter.text({
      message: "Enter Cloudflare AI Gateway ID",
      validate: (val) => (readRequiredTextInput(val) ? undefined : "Gateway ID is required"),
    });
    gatewayId = readRequiredTextInput(value);
  }
  return { accountId, gatewayId };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Cloudflare AI Gateway Provider",
  description: "Bundled Cloudflare AI Gateway provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Cloudflare AI Gateway",
      docsPath: "/providers/cloudflare-ai-gateway",
      envVars: ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
      auth: [
        {
          id: "api-key",
          label: "Cloudflare AI Gateway",
          hint: "Account ID + Gateway ID + API key",
          kind: "api_key",
          wizard: {
            choiceId: "cloudflare-ai-gateway-api-key",
            choiceLabel: "Cloudflare AI Gateway",
            choiceHint: "Account ID + Gateway ID + API key",
            groupId: "cloudflare-ai-gateway",
            groupLabel: "Cloudflare AI Gateway",
            groupHint: "Account ID + Gateway ID + API key",
          },
          run: async (ctx) => {
            const metadata = await resolveCloudflareGatewayMetadataInteractive({
              accountId: normalizeOptionalSecretInput(ctx.opts?.cloudflareAiGatewayAccountId),
              gatewayId: normalizeOptionalSecretInput(ctx.opts?.cloudflareAiGatewayGatewayId),
              prompter: ctx.prompter,
            });
            let capturedSecretInput: Parameters<typeof buildApiKeyCredential>[1] = "";
            let capturedCredential = false;
            let capturedMode: "plaintext" | "ref" | undefined;
            await ensureApiKeyFromOptionEnvOrPrompt({
              token: normalizeOptionalSecretInput(ctx.opts?.cloudflareAiGatewayApiKey),
              tokenProvider: "cloudflare-ai-gateway",
              secretInputMode:
                ctx.allowSecretRefPrompt === false
                  ? (ctx.secretInputMode ?? "plaintext")
                  : ctx.secretInputMode,
              config: ctx.config,
              expectedProviders: [PROVIDER_ID],
              provider: PROVIDER_ID,
              envLabel: PROVIDER_ENV_VAR,
              promptMessage: "Enter Cloudflare AI Gateway API key",
              normalize: normalizeApiKeyInput,
              validate: validateApiKeyInput,
              prompter: ctx.prompter,
              setCredential: async (apiKey, mode) => {
                capturedSecretInput = apiKey;
                capturedCredential = true;
                capturedMode = mode;
              },
            });
            if (!capturedCredential) {
              throw new Error("Missing Cloudflare AI Gateway API key.");
            }
            const credentialInput = capturedSecretInput ?? "";
            return {
              profiles: [
                {
                  profileId: PROFILE_ID,
                  credential: buildApiKeyCredential(
                    PROVIDER_ID,
                    credentialInput,
                    {
                      accountId: metadata.accountId,
                      gatewayId: metadata.gatewayId,
                    },
                    capturedMode ? { secretInputMode: capturedMode } : undefined,
                  ),
                },
              ],
              configPatch: buildCloudflareAiGatewayConfigPatch(metadata),
              defaultModel: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
            };
          },
          runNonInteractive: async (ctx) => {
            const authStore = ensureAuthProfileStore(ctx.agentDir, {
              allowKeychainPrompt: false,
            });
            const storedMetadata =
              authStore.profiles[PROFILE_ID]?.type === "api_key"
                ? {
                    accountId: normalizeOptionalString(
                      authStore.profiles[PROFILE_ID]?.metadata?.accountId,
                    ),
                    gatewayId: normalizeOptionalString(
                      authStore.profiles[PROFILE_ID]?.metadata?.gatewayId,
                    ),
                  }
                : {};
            const accountId =
              normalizeOptionalSecretInput(ctx.opts.cloudflareAiGatewayAccountId) ??
              storedMetadata.accountId;
            const gatewayId =
              normalizeOptionalSecretInput(ctx.opts.cloudflareAiGatewayGatewayId) ??
              storedMetadata.gatewayId;
            if (!accountId || !gatewayId) {
              ctx.runtime.error(
                "Cloudflare AI Gateway setup requires --cloudflare-ai-gateway-account-id and --cloudflare-ai-gateway-gateway-id.",
              );
              ctx.runtime.exit(1);
              return null;
            }
            const resolved = await ctx.resolveApiKey({
              provider: PROVIDER_ID,
              flagValue: normalizeOptionalSecretInput(ctx.opts.cloudflareAiGatewayApiKey),
              flagName: "--cloudflare-ai-gateway-api-key",
              envVar: PROVIDER_ENV_VAR,
            });
            if (!resolved) {
              return null;
            }
            if (resolved.source !== "profile") {
              const credential = ctx.toApiKeyCredential({
                provider: PROVIDER_ID,
                resolved,
                metadata: { accountId, gatewayId },
              });
              if (!credential) {
                return null;
              }
              upsertAuthProfile({
                profileId: PROFILE_ID,
                credential,
                agentDir: ctx.agentDir,
              });
            }
            const next = applyAuthProfileConfig(ctx.config, {
              profileId: PROFILE_ID,
              provider: PROVIDER_ID,
              mode: "api_key",
            });
            return applyCloudflareAiGatewayConfig(next, { accountId, gatewayId });
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const authStore = ensureAuthProfileStore(ctx.agentDir, {
            allowKeychainPrompt: false,
          });
          const envManagedApiKey = normalizeOptionalString(ctx.env[PROVIDER_ENV_VAR])
            ? PROVIDER_ENV_VAR
            : undefined;
          for (const profileId of listProfilesForProvider(authStore, PROVIDER_ID)) {
            const provider = buildCloudflareAiGatewayCatalogProvider({
              credential: authStore.profiles[profileId],
              envApiKey: envManagedApiKey,
            });
            if (!provider) {
              continue;
            }
            return {
              provider,
            };
          }
          return null;
        },
      },
      classifyFailoverReason: ({ errorMessage }) =>
        /\bworkers?_ai\b.*\b(?:rate|limit|quota)\b/i.test(errorMessage) ? "rate_limit" : undefined,
      wrapStreamFn: wrapCloudflareAiGatewayProviderStream,
    });
  },
});
