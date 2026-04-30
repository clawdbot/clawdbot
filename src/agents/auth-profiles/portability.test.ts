import { describe, expect, it } from "vitest";
import {
  buildPortableAuthProfileSecretsStoreForAgentCopy,
  resolveAuthProfilePortability,
} from "./portability.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

describe("auth profile portability", () => {
  it("copies static credentials but skips OAuth refresh tokens by default", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "gho-test",
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };

    const portable = buildPortableAuthProfileSecretsStoreForAgentCopy(store);

    expect(portable.copiedProfileIds).toEqual(["openai:default", "github-copilot:default"]);
    expect(portable.skippedProfileIds).toEqual(["openai-codex:default"]);
    expect(portable.store.profiles).toEqual({
      "openai:default": store.profiles["openai:default"],
      "github-copilot:default": store.profiles["github-copilot:default"],
    });
  });

  it("allows provider-owned OAuth profiles to opt in explicitly", () => {
    const credential: AuthProfileCredential = {
      type: "oauth",
      provider: "demo",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      copyToAgents: true,
    };

    expect(resolveAuthProfilePortability(credential)).toEqual({
      portable: true,
      reason: "oauth-provider-opted-in",
    });
  });

  it("lets static credentials opt out", () => {
    expect(
      resolveAuthProfilePortability({
        type: "api_key",
        provider: "openai",
        key: "sk-test",
        copyToAgents: false,
      }),
    ).toEqual({
      portable: false,
      reason: "credential-opted-out",
    });
  });
});
