import { resolveEnvApiKey } from "../agents/model-auth.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

type ArkModel = {
  id: string;
  owned_by: string;
};

export async function applyAuthChoiceVolcengine(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const authChoice = params.authChoice;

  if (authChoice !== "volcengine-api-key") {
    return null;
  }

  // 1. Get API Key
  let apiKey = resolveEnvApiKey("volcengine")?.apiKey;
  if (process.env.VOLCENGINE_API_KEY) {
    apiKey = process.env.VOLCENGINE_API_KEY;
  }

  if (params.opts?.tokenProvider === "volcengine" && params.opts?.token) {
    apiKey = params.opts.token;
  }

  if (params.opts?.volcengineApiKey) {
    apiKey = params.opts.volcengineApiKey;
  }

  if (apiKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing VOLCENGINE_API_KEY (${formatApiKeyPreview(apiKey)})?`,
      initialValue: true,
    });
    if (!useExisting) {
      apiKey = undefined;
    }
  }

  if (!apiKey) {
    const input = await params.prompter.text({
      message: "Enter Volcano Engine (ARK) API key",
      validate: validateApiKeyInput,
    });
    if (typeof input === "symbol") return null; // Aborted
    apiKey = normalizeApiKeyInput(String(input));
  }

  // Save API Key
  const result = upsertSharedEnvVar({
    key: "VOLCENGINE_API_KEY",
    value: apiKey,
  });
  if (!process.env.VOLCENGINE_API_KEY) {
    process.env.VOLCENGINE_API_KEY = apiKey;
  }

  await params.prompter.note(
    `Saved VOLCENGINE_API_KEY to ${result.path}`,
    "Volcano Engine API key",
  );

  // 2. Models (Used for config generation later)
  const models: ArkModel[] = [];

  // 3. Select Model
  let modelId: string | null = null;
  let selectionMessage = "Select a model (Auto-verified)";

  // Helper to verify model access
  const verifyModelAccess = async (id: string): Promise<boolean> => {
    const verifySpin = params.prompter.progress(`Verifying access to ${id} (10s timeout)...`);
    try {
      const res = await fetch(`${ARK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: id,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData?.error?.message || res.statusText;
        throw new Error(errMsg);
      }
      verifySpin.stop(`Access verified: ${id}`);
      return true;
    } catch (err: any) {
      verifySpin.stop("Access denied or potential timeout");
      await params.prompter.note(
        `Model "${id}" verification failed:\n${err.message}\n\nTip: You may need to create an Endpoint in ARK console or enable Pay-as-you-go.`,
        "Validation Error",
      );
      return false;
    }
  };

  while (!modelId) {
    const PREDEFINED_MODELS = [
      "glm-4-7-251222",
      "doubao-seed-1-8-251228",
      "deepseek-v3-2-251201",
      "kimi-k2-thinking-251104",
    ];

    const choices = [
      // 1. Predefined Models
      ...PREDEFINED_MODELS.map((id) => ({
        value: id,
        label: id,
        hint: "Predefined",
      })),
      // 2. Manual Entry (Always available as fallback)
      {
        value: "__manual__",
        label: "Enter Manually (e.g. Endpoint ID ep-2025...)",
        hint: "Use this if your Endpoint is not listed",
      },
    ];

    const selection = await params.prompter.select({
      message: selectionMessage,
      options: choices,
    });

    if (typeof selection === "symbol") return null;

    let candidateId: string;
    if (selection === "__manual__") {
      const input = await params.prompter.text({
        message: "Enter Endpoint ID (e.g. ep-20250604...)",
        validate: (val) => (val.length > 0 ? undefined : "Endpoint ID is required"),
      });
      if (typeof input === "symbol") return null;
      candidateId = String(input);
    } else {
      candidateId = String(selection);
    }

    // Verify validity
    const isValid = await verifyModelAccess(candidateId);
    if (isValid) {
      modelId = candidateId;
    } else {
      selectionMessage =
        "Access Denied - Please ensure you have activated this model/endpoint in ARK Console";
    }
  }

  // 4. Update Config
  let nextConfig = applyAuthProfileConfig(params.config, {
    profileId: "volcengine:default",
    provider: "volcengine", // We might need to map this provider if 'volcengine' isn't valid in core
    mode: "api_key",
  });

  // Configure default model
  // Configure default model (Always set as primary when explicitly configuring via this wizard)
  if (params.agentId) {
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: {
            ...nextConfig.agents?.defaults?.model,
            primary: `volcengine/${modelId}`, // referencing the provider/model
          },
        },
      },
    };
  } else {
    // Always set default model for the workspace globally
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: {
            ...nextConfig.agents?.defaults?.model,
            primary: `volcengine/${modelId}`,
          },
        },
      },
    };
  }

  // Configure Provider
  const existingProviderOrder = nextConfig.models?.providers;
  // We need to cast this because TypeScript might complain if we add new keys to providers if it's strictly typed
  const providers = { ...existingProviderOrder } as any;

  providers.volcengine = {
    baseUrl: ARK_BASE_URL,
    api: "openai-completions",
    apiKey: apiKey,
    models: [
      {
        id: modelId,
        name: modelId,
      },
      ...models
        .filter((m) => m.id !== modelId)
        .map((m) => ({
          id: m.id,
          name: m.id,
        })),
    ],
  };

  nextConfig = {
    ...nextConfig,
    models: {
      ...nextConfig.models,
      providers,
    },
  };

  return { config: nextConfig, agentModelOverride: modelId };
}
