/**
 * Tests auth profile portability decisions.
 * Verifies static credential copy, OAuth opt-in behavior, and explicit
 * copy-to-agent opt-outs.
 */
import { describe, expect, it } from "vitest";
import {
  buildPortableAuthProfileStoreForAgentCopy,
  resolveAuthProfilePortability,
} from "./portability.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

describe("auth profile portability", () => {
  it("copies static credentials but skips OAuth refresh tokens by default", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:api-key": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "gho-test",
        },
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: {
        openai: ["openai:default", "openai:api-key"],
        "github-copilot": ["github-copilot:default"],
      },
      lastGood: { openai: "openai:api-key" },
      usageStats: { "openai:api-key": { lastUsed: 1_000 } },
    };

    const portable = buildPortableAuthProfileStoreForAgentCopy(store);

    expect(portable.copiedProfileIds).toEqual(["openai:api-key", "github-copilot:default"]);
    expect(portable.skippedProfileIds).toEqual(["openai:default"]);
    expect(portable.store.profiles).toEqual({
      "openai:api-key": store.profiles["openai:api-key"],
      "github-copilot:default": store.profiles["github-copilot:default"],
    });
    expect(portable.store.order).toEqual({
      openai: ["openai:api-key"],
      "github-copilot": ["github-copilot:default"],
    });
    expect(portable.store.lastGood).toBeUndefined();
    expect(portable.store.usageStats).toBeUndefined();
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

  it("does not copy empty OAuth profiles even when they opt in", () => {
    const credential = {
      type: "oauth",
      provider: "openai",
      expires: Date.now() + 60_000,
      copyToAgents: true,
      oauthRef: {
        source: "openclaw-credentials",
        provider: "openai",
        id: "0123456789abcdef0123456789abcdef",
      },
    } as unknown as AuthProfileCredential;

    expect(resolveAuthProfilePortability(credential)).toEqual({
      portable: false,
      reason: "non-portable-oauth-refresh-token",
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
