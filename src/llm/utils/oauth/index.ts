/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 */

// Anthropic
// GitHub Copilot
// OpenAI Codex (ChatGPT OAuth)

export * from "./types.js";

// ============================================================================
// Built-in providers and instance-owned registries
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from "./types.js";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
];

type OAuthApiKeyResult = { newCredentials: OAuthCredentials; apiKey: string } | null;

async function resolveOAuthApiKey(
  provider: OAuthProviderInterface,
  credentials: Record<string, OAuthCredentials>,
): Promise<OAuthApiKeyResult> {
  let creds = credentials[provider.id];
  if (!creds) {
    return null;
  }

  if (Date.now() >= creds.expires) {
    try {
      creds = await provider.refreshToken(creds);
    } catch (error) {
      throw new Error(`Failed to refresh OAuth token for ${provider.id}`, { cause: error });
    }
  }

  return { newCredentials: creds, apiKey: provider.getApiKey(creds) };
}

/** Mutable OAuth provider registrations owned by one auth/session runtime. */
export class OAuthProviderRegistry {
  private providers = new Map<string, OAuthProviderInterface>();

  constructor() {
    this.reset();
  }

  get(id: OAuthProviderId): OAuthProviderInterface | undefined {
    return this.providers.get(id);
  }

  register(provider: OAuthProviderInterface): void {
    this.providers.set(provider.id, provider);
  }

  reset(): void {
    this.providers.clear();
    for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
      this.providers.set(provider.id, provider);
    }
  }

  getAll(): OAuthProviderInterface[] {
    return Array.from(this.providers.values());
  }

  async getApiKey(
    providerId: OAuthProviderId,
    credentials: Record<string, OAuthCredentials>,
  ): Promise<OAuthApiKeyResult> {
    const provider = this.get(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }
    return resolveOAuthApiKey(provider, credentials);
  }
}

/**
 * Get a built-in OAuth provider by ID.
 */
function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Get all built-in OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
  return [...BUILT_IN_OAUTH_PROVIDERS];
}

// ============================================================================
// High-level built-in provider API
// ============================================================================

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
  providerId: OAuthProviderId,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  return resolveOAuthApiKey(provider, credentials);
}
