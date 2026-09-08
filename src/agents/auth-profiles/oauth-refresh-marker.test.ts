import { describe, expect, it } from "vitest";
import {
  resolveAgentCredentialMapFromStore,
  resolveUsableAgentCredentialModes,
} from "../agent-auth-credentials.js";
import {
  createProviderApiKeyResolverFromPreparedCredentials,
  createProviderAuthResolver,
} from "../models-config.providers.secrets.js";
import {
  evaluateStoredCredentialEligibility,
  hasUsableOAuthCredential,
} from "./credential-state.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";

describe("OAuth refresh marker isolation", () => {
  it("never exposes a durable fence as configured runtime or catalog auth", () => {
    const profileId = "openai:default";
    const fence = createOAuthRefreshFence({
      profileId,
      credential: {
        type: "oauth",
        provider: "openai",
        access: "claimed-access",
        refresh: "claimed-refresh",
        expires: 1,
        accountId: "acct-123",
      },
    });
    const store = { version: 1 as const, profiles: { [profileId]: fence } };

    expect(hasUsableOAuthCredential(fence)).toBe(false);
    expect(evaluateStoredCredentialEligibility({ credential: fence })).toEqual({
      eligible: false,
      reasonCode: "expired",
    });
    expect(resolveAgentCredentialMapFromStore(store)).toEqual({});
    expect(resolveUsableAgentCredentialModes({ openai: fence })).toEqual({});

    const env = { OPENAI_API_KEY: "fallback-api-key" };
    const prepared = createProviderApiKeyResolverFromPreparedCredentials(env, {
      openai: fence,
    })("openai");
    const direct = createProviderAuthResolver(env, store)("openai", {
      oauthMarker: "oauth-marker",
    });
    expect(JSON.stringify({ prepared, direct })).not.toContain("openclaw-oauth-refresh-fence");
    expect(prepared?.mode).toBe("api_key");
    expect(direct.mode).toBe("api_key");
    expect(direct.profileId).toBeUndefined();
  });
});
