import { upsertAuthProfile } from "../../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../../agents/model-selection.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import type { MoltbotConfig } from "../../../config/config.js";
import { upsertSharedEnvVar } from "../../../infra/env-file.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "../../auth-token.js";
import { applyGoogleGeminiModelDefault } from "../../google-gemini-model-default.js";
import {
  applyAuthProfileConfig,
  applyKimiCodeConfig,
  applyMinimaxApiConfig,
  applyMinimaxConfig,
  applyMoonshotConfig,
  applyOpencodeZenConfig,
  applyOpenrouterConfig,
  applySyntheticConfig,
  applyVeniceConfig,
  applyVercelAiGatewayConfig,
  applyZaiConfig,
  setAnthropicApiKey,
  setGeminiApiKey,
  setKimiCodeApiKey,
  setMinimaxApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setSyntheticApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setZaiApiKey,
} from "../../onboard-auth.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";
import { shortenHomePath } from "../../../utils.js";

export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: MoltbotConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: MoltbotConfig;
}): Promise<MoltbotConfig | null> {
  const { authChoice, opts, runtime, baseConfig } = params;
  let nextConfig = params.nextConfig;

  if (authChoice === "claude-cli" || authChoice === "codex-cli") {
    runtime.error(
      [
        `Auth choice "${authChoice}" is deprecated.`,
        'Use "--auth-choice token" (Anthropic setup-token) or "--auth-choice openai-codex".',
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "setup-token") {
    runtime.error(
      [
        'Auth choice "setup-token" requires interactive mode.',
        'Use "--auth-choice token" with --token and --token-provider anthropic.',
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "apiKey") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "anthropic",
      cfg: baseConfig,
      flagValue: opts.anthropicApiKey,
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setAnthropicApiKey(resolved.key);
    return applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  }

  if (authChoice === "token") {
    const providerRaw = opts.tokenProvider?.trim();
    if (!providerRaw) {
      runtime.error("Missing --token-provider for --auth-choice token.");
      runtime.exit(1);
      return null;
    }
    const provider = normalizeProviderId(providerRaw);
    if (provider !== "anthropic") {
      runtime.error("Only --token-provider anthropic is supported for --auth-choice token.");
      runtime.exit(1);
      return null;
    }
    const tokenRaw = opts.token?.trim();
    if (!tokenRaw) {
      runtime.error("Missing --token for --auth-choice token.");
      runtime.exit(1);
      return null;
    }
    const tokenError = validateAnthropicSetupToken(tokenRaw);
    if (tokenError) {
      runtime.error(tokenError);
      runtime.exit(1);
      return null;
    }

    let expires: number | undefined;
    const expiresInRaw = opts.tokenExpiresIn?.trim();
    if (expiresInRaw) {
      try {
        expires = Date.now() + parseDurationMs(expiresInRaw, { defaultUnit: "d" });
      } catch (err) {
        runtime.error(`Invalid --token-expires-in: ${String(err)}`);
        runtime.exit(1);
        return null;
      }
    }

    const profileId = opts.tokenProfileId?.trim() || buildTokenProfileId({ provider, name: "" });
    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider,
        token: tokenRaw.trim(),
        ...(expires ? { expires } : {}),
      },
    });
    return applyAuthProfileConfig(nextConfig, {
      profileId,
      provider,
      mode: "token",
    });
  }

  if (authChoice === "gemini-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "google",
      cfg: baseConfig,
      flagValue: opts.geminiApiKey,
      flagName: "--gemini-api-key",
      envVar: "GEMINI_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setGeminiApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    return applyGoogleGeminiModelDefault(nextConfig).next;
  }

  if (authChoice === "zai-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "zai",
      cfg: baseConfig,
      flagValue: opts.zaiApiKey,
      flagName: "--zai-api-key",
      envVar: "ZAI_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setZaiApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });
    return applyZaiConfig(nextConfig);
  }

  if (authChoice === "openai-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "openai",
      cfg: baseConfig,
      flagValue: opts.openaiApiKey,
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
      runtime,
      allowProfile: false,
    });
    if (!resolved) return null;
    const key = resolved.key;
    const result = upsertSharedEnvVar({ key: "OPENAI_API_KEY", value: key });
    process.env.OPENAI_API_KEY = key;
    runtime.log(`Saved OPENAI_API_KEY to ${shortenHomePath(result.path)}`);
    return nextConfig;
  }

  if (authChoice === "openrouter-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "openrouter",
      cfg: baseConfig,
      flagValue: opts.openrouterApiKey,
      flagName: "--openrouter-api-key",
      envVar: "OPENROUTER_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setOpenrouterApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openrouter:default",
      provider: "openrouter",
      mode: "api_key",
    });
    return applyOpenrouterConfig(nextConfig);
  }

  if (authChoice === "ai-gateway-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "vercel-ai-gateway",
      cfg: baseConfig,
      flagValue: opts.aiGatewayApiKey,
      flagName: "--ai-gateway-api-key",
      envVar: "AI_GATEWAY_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setVercelAiGatewayApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "vercel-ai-gateway:default",
      provider: "vercel-ai-gateway",
      mode: "api_key",
    });
    return applyVercelAiGatewayConfig(nextConfig);
  }

  if (authChoice === "moonshot-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "moonshot",
      cfg: baseConfig,
      flagValue: opts.moonshotApiKey,
      flagName: "--moonshot-api-key",
      envVar: "MOONSHOT_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setMoonshotApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "moonshot:default",
      provider: "moonshot",
      mode: "api_key",
    });
    return applyMoonshotConfig(nextConfig);
  }

  if (authChoice === "kimi-code-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "kimi-code",
      cfg: baseConfig,
      flagValue: opts.kimiCodeApiKey,
      flagName: "--kimi-code-api-key",
      envVar: "KIMICODE_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setKimiCodeApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "kimi-code:default",
      provider: "kimi-code",
      mode: "api_key",
    });
    return applyKimiCodeConfig(nextConfig);
  }

  if (authChoice === "synthetic-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "synthetic",
      cfg: baseConfig,
      flagValue: opts.syntheticApiKey,
      flagName: "--synthetic-api-key",
      envVar: "SYNTHETIC_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setSyntheticApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "synthetic:default",
      provider: "synthetic",
      mode: "api_key",
    });
    return applySyntheticConfig(nextConfig);
  }

  if (authChoice === "venice-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "venice",
      cfg: baseConfig,
      flagValue: opts.veniceApiKey,
      flagName: "--venice-api-key",
      envVar: "VENICE_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setVeniceApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "venice:default",
      provider: "venice",
      mode: "api_key",
    });
    return applyVeniceConfig(nextConfig);
  }

  if (
    authChoice === "minimax-cloud" ||
    authChoice === "minimax-api" ||
    authChoice === "minimax-api-lightning"
  ) {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "minimax",
      cfg: baseConfig,
      flagValue: opts.minimaxApiKey,
      flagName: "--minimax-api-key",
      envVar: "MINIMAX_API_KEY",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setMinimaxApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    const modelId =
      authChoice === "minimax-api-lightning" ? "MiniMax-M2.1-lightning" : "MiniMax-M2.1";
    return applyMinimaxApiConfig(nextConfig, modelId);
  }

  if (authChoice === "minimax") return applyMinimaxConfig(nextConfig);

  if (authChoice === "opencode-zen") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "opencode",
      cfg: baseConfig,
      flagValue: opts.opencodeZenApiKey,
      flagName: "--opencode-zen-api-key",
      envVar: "OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY)",
      runtime,
    });
    if (!resolved) return null;
    if (resolved.source !== "profile") await setOpencodeZenApiKey(resolved.key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "opencode:default",
      provider: "opencode",
      mode: "api_key",
    });
    return applyOpencodeZenConfig(nextConfig);
  }

  if (
    authChoice === "oauth" ||
    authChoice === "chutes" ||
    authChoice === "openai-codex" ||
    authChoice === "qwen-portal"
  ) {
    runtime.error("OAuth requires interactive mode.");
    runtime.exit(1);
    return null;
  }

  return nextConfig;
}
