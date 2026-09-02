import type { Platform, Provider, ProviderAuth } from "./types.ts";

type ProviderAuthResult =
  | { auth: ProviderAuth; reason: null; status: "ready" }
  | { auth: ProviderAuth; reason: "credential_missing"; status: "blocked" };

export function resolveParallelsProviderAuth(
  input: { apiKeyEnv?: string; modelId?: string; platform?: Platform; provider: Provider },
  env: Record<string, string | undefined>,
): ProviderAuthResult;

export function parsePlatformList(value: string): Set<Platform>;

export function runParallelsPrerequisiteEval(
  argv: string[],
  env: Record<string, string | undefined>,
  io: { write(value: string): unknown },
): 0 | 1;
