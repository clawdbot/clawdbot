import { describe, expect, it } from "vitest";
import { buildOpenAICodexSetupProvider, buildOpenAISetupProvider } from "./setup-api.js";

function authMethodIds(provider: ReturnType<typeof buildOpenAISetupProvider>) {
  return provider.auth.map((method) => method.id);
}

describe("OpenAI setup auth provider", () => {
  it("offers ChatGPT login as the default OpenAI auth path while keeping API key explicit", () => {
    const provider = buildOpenAISetupProvider();
    const oauth = provider.auth.find((method) => method.id === "oauth");
    const apiKey = provider.auth.find((method) => method.id === "api-key");

    expect(provider.id).toBe("openai");
    expect(authMethodIds(provider)).toEqual(["oauth", "device-code", "api-key"]);
    expect(oauth?.label).toBe("ChatGPT Login");
    expect(oauth?.wizard?.choiceId).toBe("openai");
    expect(oauth?.wizard?.assistantVisibility).toBe("manual-only");
    expect(apiKey?.label).toBe("OpenAI API Key");
    expect(apiKey?.wizard?.choiceId).toBe("openai-api-key");
  });

  it("keeps the legacy openai-codex setup provider available", () => {
    const provider = buildOpenAICodexSetupProvider();

    expect(provider.id).toBe("openai-codex");
    expect(authMethodIds(provider)).toEqual(["oauth", "device-code", "api-key"]);
  });
});
