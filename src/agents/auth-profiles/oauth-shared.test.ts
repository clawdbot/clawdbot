import { describe, expect, it, vi } from "vitest";
import { MAX_DATE_TIMESTAMP_MS } from "../../shared/number-coercion.js";
import {
  overlayRuntimeExternalOAuthProfiles,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

describe("overlayRuntimeExternalOAuthProfiles", () => {
  it("isolates runtime OAuth overlays without structuredClone", () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
      order: {
        openai: ["openai:default"],
      },
    };

    try {
      const overlaid = overlayRuntimeExternalOAuthProfiles(store, [
        {
          profileId: "openai:default",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "access-1",
            refresh: "refresh-1",
            expires: Date.now() + 60_000,
          },
        },
      ]);

      const overlaidCodexProfile = overlaid.profiles["openai:default"];
      expect(overlaidCodexProfile?.type).toBe("oauth");
      if (overlaidCodexProfile?.type !== "oauth") {
        throw new Error("expected overlaid Codex OAuth profile");
      }
      expect(overlaidCodexProfile.access).toBe("access-1");
      expect(store.profiles["openai:default"]?.type).toBe("api_key");

      overlaid.profiles["openai:default"].provider = "mutated";
      overlaid.order!.openai.push("mutated");

      expect(store.profiles["openai:default"]?.provider).toBe("openai");
      expect(store.order?.openai).toEqual(["openai:default"]);
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
    }
  });

  it("preserves existing runtime-only provenance for non-authoritative overlays", () => {
    const store: AuthProfileStore = {
      version: 1,
      runtimeExternalProfileIds: ["minimax:minimax-cli"],
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
          access: "old-access",
          refresh: "old-refresh",
          expires: 1,
        },
        "minimax:minimax-cli": {
          type: "oauth",
          provider: "minimax-portal",
          access: "minimax-access",
          refresh: "minimax-refresh",
          expires: 1,
        },
      },
    };

    const overlaid = overlayRuntimeExternalOAuthProfiles(store, [
      {
        profileId: "anthropic:claude-cli",
        credential: {
          type: "oauth",
          provider: "anthropic",
          access: "new-access",
          refresh: "new-refresh",
          expires: 2,
        },
      },
    ]);

    expect(overlaid.runtimeExternalProfileIds).toEqual([
      "anthropic:claude-cli",
      "minimax:minimax-cli",
    ]);
  });

  it("preserves existing runtime-only provenance for authoritative overlays", () => {
    const store: AuthProfileStore = {
      version: 1,
      runtimeExternalProfileIds: ["minimax:minimax-cli"],
      runtimeExternalProfileIdsAuthoritative: true,
      profiles: {
        "minimax:minimax-cli": {
          type: "oauth",
          provider: "minimax-portal",
          access: "minimax-access",
          refresh: "minimax-refresh",
          expires: 1,
        },
      },
    };

    const overlaid = overlayRuntimeExternalOAuthProfiles(store, [], {
      runtimeExternalProfileIdsAuthoritative: true,
    });

    expect(overlaid.runtimeExternalProfileIds).toEqual(["minimax:minimax-cli"]);
    expect(overlaid.runtimeExternalProfileIdsAuthoritative).toBe(true);
  });

  it("replaces an existing OAuth credential with an out-of-range expiry", () => {
    const existing: OAuthCredential = {
      type: "oauth",
      provider: "openai-codex",
      access: "poisoned-access",
      refresh: "poisoned-refresh",
      expires: MAX_DATE_TIMESTAMP_MS + 1,
    };
    const incoming: OAuthCredential = {
      type: "oauth",
      provider: "openai-codex",
      access: "valid-access",
      refresh: "valid-refresh",
      expires: Date.now() + 60_000,
    };

    expect(shouldReplaceStoredOAuthCredential(existing, incoming)).toBe(true);
  });
});
