import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { die, run } from "./host-command.ts";
import type { Mode, Platform, Provider, ProviderAuth } from "./types.ts";

export function parseBoolEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

export function ensureValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value == null || value === "") {
    die(`${flag} requires a value`);
  }
  return value;
}

export function resolveProviderAuth(input: {
  provider: Provider;
  apiKeyEnv?: string;
  modelId?: string;
}): ProviderAuth {
  const providerDefaults: Record<Provider, Omit<ProviderAuth, "apiKeyValue">> = {
    anthropic: {
      apiKeyEnv: input.apiKeyEnv || "ANTHROPIC_API_KEY",
      authChoice: "apiKey",
      authKeyFlag: "anthropic-api-key",
      modelId:
        input.modelId ||
        process.env.OPENCLAW_PARALLELS_ANTHROPIC_MODEL ||
        "anthropic/claude-sonnet-4-6",
    },
    minimax: {
      apiKeyEnv: input.apiKeyEnv || "MINIMAX_API_KEY",
      authChoice: "minimax-global-api",
      authKeyFlag: "minimax-api-key",
      modelId:
        input.modelId || process.env.OPENCLAW_PARALLELS_MINIMAX_MODEL || "minimax/MiniMax-M2.7",
    },
    openai: {
      apiKeyEnv: input.apiKeyEnv || "OPENAI_API_KEY",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: input.modelId || process.env.OPENCLAW_PARALLELS_OPENAI_MODEL || "openai/gpt-5.5",
    },
  };
  const resolved = providerDefaults[input.provider];
  const apiKeyValue = process.env[resolved.apiKeyEnv] ?? "";
  if (!apiKeyValue) {
    die(`${resolved.apiKeyEnv} is required`);
  }
  return { ...resolved, apiKeyValue };
}

export function resolveWindowsProviderAuth(input: {
  provider: Provider;
  apiKeyEnv?: string;
  modelId?: string;
}): ProviderAuth {
  const auth = resolveProviderAuth(input);
  if (input.provider !== "openai" || input.modelId) {
    return auth;
  }
  const windowsModel = process.env.OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL?.trim();
  if (windowsModel) {
    return { ...auth, modelId: windowsModel };
  }
  if (process.env.OPENCLAW_PARALLELS_OPENAI_MODEL?.trim()) {
    return auth;
  }
  return { ...auth, modelId: "openai/gpt-5.5" };
}

export function providerIdFromModelId(modelId: string): string {
  const providerId = modelId.split("/", 1)[0]?.trim() ?? "";
  return /^[A-Za-z0-9_-]+$/u.test(providerId) ? providerId : "";
}

export function resolveParallelsModelTimeoutSeconds(platform?: Platform): number {
  const platformEnv =
    platform === undefined
      ? undefined
      : process.env[`OPENCLAW_PARALLELS_${platform.toUpperCase()}_MODEL_TIMEOUT_S`];
  const defaultSeconds = platform === "macos" || platform === "windows" ? 1800 : 900;
  const raw = Number(
    platformEnv || process.env.OPENCLAW_PARALLELS_MODEL_TIMEOUT_S || defaultSeconds,
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultSeconds;
}

export function providerTimeoutConfigJson(modelId: string, platform: Platform): string {
  const providerId = providerIdFromModelId(modelId);
  if (providerId !== "openai") {
    return "";
  }
  const modelName = modelId.slice("openai/".length).trim();
  if (!modelName) {
    return "";
  }
  return JSON.stringify({
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        contextWindow: 1_047_576,
        id: modelName,
        maxTokens: 32_768,
        name: modelName,
      },
    ],
    timeoutSeconds: resolveParallelsModelTimeoutSeconds(platform),
  });
}

export function modelTransportConfigJson(modelId: string): string {
  if (providerIdFromModelId(modelId) !== "openai") {
    return "";
  }
  return JSON.stringify({
    alias: "GPT",
    params: {
      transport: "sse",
    },
  });
}

export function configPathMapKey(key: string): string {
  return `[${JSON.stringify(key)}]`;
}

export function modelProviderConfigBatchJson(modelId: string, platform: Platform): string {
  const commands: Array<{ path: string; value: unknown }> = [];
  const providerId = providerIdFromModelId(modelId);
  const providerConfig = providerTimeoutConfigJson(modelId, platform);
  if (providerId && providerConfig) {
    commands.push({
      path: `models.providers.${providerId}`,
      value: JSON.parse(providerConfig) as unknown,
    });
  }
  const modelTransportConfig = modelTransportConfigJson(modelId);
  if (modelTransportConfig) {
    commands.push({
      path: `agents.defaults.models${configPathMapKey(modelId)}`,
      value: JSON.parse(modelTransportConfig) as unknown,
    });
  }
  return commands.length === 0 ? "" : JSON.stringify(commands);
}

export function parseProvider(value: string): Provider {
  if (value === "openai" || value === "anthropic" || value === "minimax") {
    return value;
  }
  return die(`invalid --provider: ${value}`);
}

export function parseMode(value: string): Mode {
  if (value === "fresh" || value === "upgrade" || value === "both") {
    return value;
  }
  return die(`invalid --mode: ${value}`);
}

export function parsePlatformList(value: string): Set<Platform> {
  const normalized = value.replaceAll(" ", "");
  if (normalized === "all") {
    return new Set(["macos", "windows", "linux"]);
  }
  const result = new Set<Platform>();
  for (const entry of normalized.split(",")) {
    if (entry === "macos" || entry === "windows" || entry === "linux") {
      result.add(entry);
    } else {
      die(`invalid --platform entry: ${entry}`);
    }
  }
  if (result.size === 0) {
    die("--platform must include at least one platform");
  }
  return result;
}

export function resolveLatestVersion(versionOverride = ""): string {
  if (versionOverride) {
    return versionOverride;
  }
  return run(
    "npm",
    [
      "view",
      "openclaw",
      "version",
      "--userconfig",
      mkdtempSync(path.join(tmpdir(), "openclaw-npm-")),
    ],
    {
      quiet: true,
    },
  ).stdout.trim();
}
