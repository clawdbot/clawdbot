import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

type CloudflareAiGatewayCredential =
  | {
      type?: string;
      keyRef?: unknown;
      key?: unknown;
      metadata?: {
        accountId?: unknown;
        gatewayId?: unknown;
      };
    }
  | undefined;

function resolveCloudflareAiGatewayApiKey(cred: CloudflareAiGatewayCredential): string | undefined {
  if (!cred || cred.type !== "api_key") {
    return undefined;
  }

  const keyRef = coerceSecretRef(cred.keyRef);
  const keyRefId = normalizeOptionalString(keyRef?.id);
  if (keyRef && keyRefId) {
    return keyRef.source === "env" ? keyRefId : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
  }
  return normalizeOptionalString(cred.key);
}

function resolveCloudflareAiGatewayMetadata(cred: CloudflareAiGatewayCredential): {
  accountId?: string;
  gatewayId?: string;
} {
  if (!cred || cred.type !== "api_key") {
    return {};
  }
  return {
    accountId: normalizeOptionalString(cred.metadata?.accountId),
    gatewayId: normalizeOptionalString(cred.metadata?.gatewayId),
  };
}

export function buildCloudflareAiGatewayCatalogProvider(params: {
  credential: CloudflareAiGatewayCredential;
  envApiKey?: string;
}) {
  const apiKey =
    normalizeOptionalString(params.envApiKey) ??
    resolveCloudflareAiGatewayApiKey(params.credential);
  if (!apiKey) {
    return null;
  }
  const { accountId, gatewayId } = resolveCloudflareAiGatewayMetadata(params.credential);
  if (!accountId || !gatewayId) {
    return null;
  }
  const baseUrl = resolveCloudflareAiGatewayBaseUrl({ accountId, gatewayId });
  if (!baseUrl) {
    return null;
  }
  return {
    baseUrl,
    api: "anthropic-messages" as const,
    apiKey,
    models: [buildCloudflareAiGatewayModelDefinition()],
  };
}
