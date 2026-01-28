import { loginOpenAICodex } from "@mariozechner/pi-ai";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";

function readConfigEnvValue(cfg: { env?: Record<string, unknown> }, key: string): string | null {
  const env = cfg.env;
  if (!env) return null;
  const direct = env[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const vars = env.vars as Record<string, unknown> | undefined;
  const fromVars = vars?.[key];
  if (typeof fromVars === "string" && fromVars.trim()) return fromVars.trim();
  return null;
}

function setConfigEnvValue<T extends { env?: Record<string, unknown> }>(
  cfg: T,
  key: string,
  value: string,
): T {
  const existing = cfg.env ?? {};
  const vars =
    existing.vars && typeof existing.vars === "object"
      ? { ...(existing.vars as Record<string, string>) }
      : undefined;
  if (vars && Object.prototype.hasOwnProperty.call(vars, key)) {
    vars[key] = value;
    return { ...cfg, env: { ...existing, vars } } as T;
  }
  return { ...cfg, env: { ...existing, [key]: value, ...(vars ? { vars } : {}) } } as T;
}

export async function applyAuthChoiceOpenAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let authChoice = params.authChoice;
  if (authChoice === "apiKey" && params.opts?.tokenProvider === "openai") {
    authChoice = "openai-api-key";
  }

  if (authChoice === "openai-custom-endpoint") {
    let nextConfig = params.config;
    const existingBaseUrl =
      readConfigEnvValue(nextConfig, "OPENAI_BASE_URL") ??
      process.env.OPENAI_BASE_URL?.trim() ??
      "";
    const existingToken =
      readConfigEnvValue(nextConfig, "OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY?.trim() ?? "";

    let baseUrl = existingBaseUrl;
    if (existingBaseUrl) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing OPENAI_BASE_URL (${existingBaseUrl})?`,
        initialValue: true,
      });
      if (!useExisting) baseUrl = "";
    }
    if (!baseUrl) {
      const input = await params.prompter.text({
        message: "OpenAI-compatible base URL",
        placeholder: "https://api.example.com/v1",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      baseUrl = String(input ?? "").trim();
    }

    let token = existingToken;
    if (existingToken) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing OPENAI_API_KEY (${formatApiKeyPreview(existingToken)})?`,
        initialValue: true,
      });
      if (!useExisting) token = "";
    }
    if (!token) {
      const input = await params.prompter.text({
        message: "Bearer token",
        validate: validateApiKeyInput,
      });
      token = normalizeApiKeyInput(String(input));
    }

    nextConfig = setConfigEnvValue(nextConfig, "OPENAI_BASE_URL", baseUrl);
    nextConfig = setConfigEnvValue(nextConfig, "OPENAI_API_KEY", token);
    process.env.OPENAI_BASE_URL = baseUrl;
    process.env.OPENAI_API_KEY = token;
    await params.prompter.note(
      "Saved OPENAI_BASE_URL and OPENAI_API_KEY in config env.",
      "OpenAI endpoint",
    );
    return { config: nextConfig };
  }

  if (authChoice === "openai-api-key") {
    const envKey = resolveEnvApiKey("openai");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing OPENAI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        const result = upsertSharedEnvVar({
          key: "OPENAI_API_KEY",
          value: envKey.apiKey,
        });
        if (!process.env.OPENAI_API_KEY) {
          process.env.OPENAI_API_KEY = envKey.apiKey;
        }
        await params.prompter.note(
          `Copied OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
          "OpenAI API key",
        );
        return { config: params.config };
      }
    }

    let key: string | undefined;
    if (params.opts?.token && params.opts?.tokenProvider === "openai") {
      key = params.opts.token;
    } else {
      key = await params.prompter.text({
        message: "Enter OpenAI API key",
        validate: validateApiKeyInput,
      });
    }

    const trimmed = normalizeApiKeyInput(String(key));
    const result = upsertSharedEnvVar({
      key: "OPENAI_API_KEY",
      value: trimmed,
    });
    process.env.OPENAI_API_KEY = trimmed;
    await params.prompter.note(
      `Saved OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
      "OpenAI API key",
    );
    return { config: params.config };
  }

  if (params.authChoice === "openai-codex") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;
    const noteAgentModel = async (model: string) => {
      if (!params.agentId) return;
      await params.prompter.note(
        `Default model set to ${model} for agent "${params.agentId}".`,
        "Model configured",
      );
    };

    const isRemote = isRemoteEnvironment();
    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, paste the redirect URL back here.",
          ].join("\n")
        : [
            "Browser will open for OpenAI authentication.",
            "If the callback doesn't auto-complete, paste the redirect URL.",
            "OpenAI OAuth uses localhost:1455 for the callback.",
          ].join("\n"),
      "OpenAI Codex OAuth",
    );
    const spin = params.prompter.progress("Starting OAuth flow…");
    try {
      const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
        isRemote,
        prompter: params.prompter,
        runtime: params.runtime,
        spin,
        openUrl,
        localBrowserMessage: "Complete sign-in in browser…",
      });

      const creds = await loginOpenAICodex({
        onAuth,
        onPrompt,
        onProgress: (msg) => spin.update(msg),
      });
      spin.stop("OpenAI OAuth complete");
      if (creds) {
        await writeOAuthCredentials("openai-codex", creds, params.agentDir);
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          mode: "oauth",
        });
        if (params.setDefaultModel) {
          const applied = applyOpenAICodexModelDefault(nextConfig);
          nextConfig = applied.next;
          if (applied.changed) {
            await params.prompter.note(
              `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
              "Model configured",
            );
          }
        } else {
          agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
          await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
        }
      }
    } catch (err) {
      spin.stop("OpenAI OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.molt.bot/start/faq",
        "OAuth help",
      );
    }
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
