import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
// Openai tests cover setup api plugin behavior.
import { describe, expect, it } from "vitest";
import { buildOpenAISetupProvider } from "./setup-api.js";

function authMethodIds(provider: ReturnType<typeof buildOpenAISetupProvider>) {
  return provider.auth.map((method) => method.id);
}

describe("OpenAI setup auth provider", () => {
  it("retains exact personal-account matching on both setup sign-in methods", () => {
    const credentialFor = (userId: string): OAuthCredential => ({
      type: "oauth",
      provider: "openai",
      expires: 1,
      refresh: "synthetic-refresh",
      access: `header.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "workspace",
            chatgpt_user_id: userId,
          },
        }),
      ).toString("base64url")}.signature`,
    });
    const credential = credentialFor("alice");
    for (const methodId of ["oauth", "device-code"]) {
      const method = buildOpenAISetupProvider().auth.find((entry) => entry.id === methodId);
      expect(method?.matchesPersonalAccount).toBeTypeOf("function");
      expect(method?.matchesPersonalAccount?.(credential, credentialFor("alice"))).toBe(true);
      expect(method?.matchesPersonalAccount?.(credential, credentialFor("bob"))).toBe(false);
    }
  });
  it("offers ChatGPT login as the default OpenAI auth path while keeping API key explicit", () => {
    const provider = buildOpenAISetupProvider();
    const oauth = provider.auth.find((method) => method.id === "oauth");
    const apiKey = provider.auth.find((method) => method.id === "api-key");

    expect(provider.id).toBe("openai");
    expect(authMethodIds(provider)).toEqual(["oauth", "device-code", "api-key"]);
    expect(oauth?.label).toBe("ChatGPT Login");
    expect(oauth?.wizard?.choiceId).toBe("openai");
    expect(apiKey?.label).toBe("OpenAI API Key");
    expect(apiKey?.wizard?.choiceId).toBe("openai-api-key");
  });
});
