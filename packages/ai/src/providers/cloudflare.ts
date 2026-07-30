// Cloudflare provider metadata describes Cloudflare-hosted model capabilities.
import type { Model } from "../types.js";

// This module owns URL metadata only; Anthropic/OpenAI adapters inject guarded fetch.

export function isCloudflareProvider(provider: string): boolean {
  return provider === "cloudflare-workers-ai" || provider === "cloudflare-ai-gateway";
}

/** Substitute `{VAR}` placeholders in a Cloudflare baseUrl from process.env. */
export function resolveCloudflareBaseUrl(model: Model): string {
  const url = model.baseUrl;
  if (!url.includes("{")) {
    return url;
  }
  const baseUrl = url.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is required for provider ${model.provider} but is not set.`);
    }
    return value;
  });
  return baseUrl;
}
