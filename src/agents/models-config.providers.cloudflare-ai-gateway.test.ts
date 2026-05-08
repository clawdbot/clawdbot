import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import type { ApiKeyCredential } from "./auth-profiles/types.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveApiKeyFromCredential } from "./models-config.providers.secret-helpers.js";

function expectedCloudflareGatewayBaseUrl(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}

function buildCloudflareAiGatewayCatalogProvider(params: {
  credential:
    | (ApiKeyCredential & {
        metadata?: {
          accountId?: string;
          gatewayId?: string;
        };
      })
    | undefined;
  envApiKey?: string;
}) {
  const apiKey = params.envApiKey?.trim() || resolveApiKeyFromCredential(params.credential)?.apiKey;
  const accountId = params.credential?.metadata?.accountId?.trim();
  const gatewayId = params.credential?.metadata?.gatewayId?.trim();
  if (!apiKey || !accountId || !gatewayId) {
    return null;
  }
  return {
    baseUrl: expectedCloudflareGatewayBaseUrl(accountId, gatewayId),
    api: "anthropic-messages",
    apiKey,
    models: [{ id: "cloudflare-ai-gateway" }],
  };
}

describe("cloudflare-ai-gateway profile provenance", () => {
  it("prefers env keyRef marker over runtime plaintext for persistence", () => {
    const envSnapshot = captureEnv(["CLOUDFLARE_AI_GATEWAY_API_KEY"]);
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
    try {
      const provider = buildCloudflareAiGatewayCatalogProvider({
        credential: {
          type: "api_key",
          provider: "cloudflare-ai-gateway",
          key: "sk-runtime-cloudflare",
          keyRef: { source: "env", provider: "default", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
          metadata: {
            accountId: "acct_123",
            gatewayId: "gateway_456",
          },
        },
      });
      expect(provider?.apiKey).toBe("CLOUDFLARE_AI_GATEWAY_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for non-env keyRef cloudflare profiles", () => {
    const provider = buildCloudflareAiGatewayCatalogProvider({
      credential: {
        type: "api_key",
        provider: "cloudflare-ai-gateway",
        key: "sk-runtime-cloudflare",
        keyRef: { source: "file", provider: "vault", id: "/cloudflare/apiKey" },
        metadata: {
          accountId: "acct_123",
          gatewayId: "gateway_456",
        },
      },
    });
    expect(provider?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("keeps Cloudflare gateway metadata and apiKey from the same auth profile", () => {
    const provider = buildCloudflareAiGatewayCatalogProvider({
      credential: {
        type: "api_key",
        provider: "cloudflare-ai-gateway",
        key: "sk-second",
        metadata: {
          accountId: "acct_456",
          gatewayId: "gateway_789",
        },
      },
    });
    expect(provider?.apiKey).toBe("sk-second");
    expect(provider?.baseUrl).toBe(expectedCloudflareGatewayBaseUrl("acct_456", "gateway_789"));
  });

  it("prefers the runtime env marker over stored profile secrets", () => {
    const envSnapshot = captureEnv(["CLOUDFLARE_AI_GATEWAY_API_KEY"]);
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "rotated-secret"; // pragma: allowlist secret

    try {
      const provider = buildCloudflareAiGatewayCatalogProvider({
        credential: {
          type: "api_key",
          provider: "cloudflare-ai-gateway",
          key: "stale-stored-secret",
          metadata: {
            accountId: "acct_123",
            gatewayId: "gateway_456",
          },
        },
        envApiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      });
      expect(provider?.apiKey).toBe("CLOUDFLARE_AI_GATEWAY_API_KEY");
      expect(provider?.baseUrl).toBe(expectedCloudflareGatewayBaseUrl("acct_123", "gateway_456"));
    } finally {
      envSnapshot.restore();
    }
  });
});
