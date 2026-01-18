import { hashText } from "./internal.js";
import { fingerprintHeaderNames } from "./headers-fingerprint.js";

export function computeEmbeddingProviderKey(params: {
  providerId: string;
  providerModel: string;
  openAi?: { baseUrl: string; model: string; headers: Record<string, string> };
}): string {
  if (params.openAi) {
    const headerNames = fingerprintHeaderNames(params.openAi.headers);
    return hashText(
      JSON.stringify({
        provider: "openai",
        baseUrl: params.openAi.baseUrl,
        model: params.openAi.model,
        headerNames,
      }),
    );
  }
  return hashText(JSON.stringify({ provider: params.providerId, model: params.providerModel }));
}
