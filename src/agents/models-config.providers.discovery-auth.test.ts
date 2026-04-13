import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveApiKeyFromCredential } from "./models-config.providers.secret-helpers.js";

describe("provider discovery auth marker guardrails", () => {
  it("suppresses discovery secrets for marker-backed vLLM credentials", () => {
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "vllm",
      keyRef: { source: "file", provider: "vault", id: "/vllm/apiKey" },
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(resolved?.discoveryApiKey).toBeUndefined();
  });

  it("suppresses discovery secrets for marker-backed Hugging Face credentials", () => {
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "huggingface",
      keyRef: { source: "exec", provider: "vault", id: "providers/hf/token" },
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(resolved?.discoveryApiKey).toBeUndefined();
  });

  it("keeps all-caps plaintext API keys for authenticated discovery", () => {
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "vllm",
      key: "ALLCAPS_SAMPLE",
    });

    expect(resolved?.apiKey).toBe("ALLCAPS_SAMPLE");
    expect(resolved?.discoveryApiKey).toBe("ALLCAPS_SAMPLE");
  });
});
