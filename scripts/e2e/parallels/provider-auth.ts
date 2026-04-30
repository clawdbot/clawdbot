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
      modelId: input.modelId || process.env.OPENCLAW_PARALLELS_OPENAI_MODEL || "openai/gpt-5.4",
    },
  };
  const resolved = providerDefaults[input.provider];
  const apiKeyValue = process.env[resolved.apiKeyEnv] ?? "";
  if (!apiKeyValue) {
    die(`${resolved.apiKeyEnv} is required`);
  }
  return { ...resolved, apiKeyValue };
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
