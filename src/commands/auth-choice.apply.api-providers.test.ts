import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "./auth-choice.apply.api-providers.js";

const resolvePluginProviders = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders>(),
);
const resolvePluginSetupProvider = vi.hoisted(() => vi.fn(() => undefined));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolvePluginSetupProvider,
}));

function createProvider(params: {
  id: string;
  aliases?: string[];
  auth: Array<{
    id: string;
    kind: ProviderPlugin["auth"][number]["kind"];
    choiceId?: string;
  }>;
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.id,
    ...(params.aliases ? { aliases: params.aliases } : {}),
    auth: params.auth.map((method) => ({
      id: method.id,
      label: method.id,
      kind: method.kind,
      ...(method.choiceId ? { wizard: { choiceId: method.choiceId } } : {}),
      run: vi.fn(async () => ({ profiles: [] })),
    })),
  };
}

describe("normalizeApiKeyTokenProviderAuthChoice", () => {
  afterEach(() => {
    resolvePluginProviders.mockReset();
  });

  it("maps token provider auth through plugin token methods", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "anthropic",
        auth: [{ id: "setup-token", kind: "token", choiceId: "setup-token" }],
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "token",
        tokenProvider: " anthropic ",
      }),
    ).toBe("setup-token");
  });

  it("maps apiKey provider auth through plugin api key methods and aliases", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "google",
        aliases: ["gemini"],
        auth: [{ id: "api-key", kind: "api_key", choiceId: "gemini-api-key" }],
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "apiKey",
        tokenProvider: " GeMiNi ",
      }),
    ).toBe("gemini-api-key");
  });

  it("leaves the auth choice unchanged when no matching provider method exists", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "openai",
        auth: [{ id: "api-key", kind: "api_key", choiceId: "openai-api-key" }],
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "token",
        tokenProvider: "openai",
      }),
    ).toBe("token");
  });
});
