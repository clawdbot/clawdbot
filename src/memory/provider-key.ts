import { hashText } from "./internal.js";
import { fingerprintHeaderNames } from "./headers-fingerprint.js";

export function computeEmbeddingProviderKey(params: {
  providerId: string;
  providerModel: string;
  openAi?: { baseUrl: string; model: string; headers: Record<string, string> };
  gemini?: { baseUrl: string; model: string; headers: Record<string, string> };
  openRouter?: { baseUrl: string; model: string; headers: Record<string, string> };
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
  if (params.gemini) {
    const headerNames = fingerprintHeaderNames(params.gemini.headers);
    return hashText(
      JSON.stringify({
        provider: "gemini",
        baseUrl: params.gemini.baseUrl,
        model: params.gemini.model,
        headerNames,
      }),
    );
  }
  if (params.openRouter) {
    const headerNames = fingerprintHeaderNames(params.openRouter.headers);
    return hashText(
      JSON.stringify({
        provider: "openrouter",
        baseUrl: params.openRouter.baseUrl,
        model: params.openRouter.model,
        headerNames,
      }),
    );
  }
  return hashText(JSON.stringify({ provider: params.providerId, model: params.providerModel }));
}
