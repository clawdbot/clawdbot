/** Tests the retained generic external-CLI OAuth contract. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";

const readMiniMaxCliCredentialsCached = vi.hoisted(() => vi.fn());
vi.mock("./cli-credentials.js", () => ({ readMiniMaxCliCredentialsCached }));

import {
  readExternalCliBootstrapCredential,
  resolveExternalCliAuthProfiles,
} from "./auth-profiles/external-cli-sync.js";

const profileId = "minimax-portal:minimax-cli";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "minimax-portal",
    access: "minimax-access",
    refresh: "minimax-refresh",
    expires: Date.now() + 24 * 60 * 60_000,
    ...overrides,
  };
}

function store(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return { version: 1, profiles };
}

describe("external CLI OAuth resolution", () => {
  beforeEach(() => {
    readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
  });

  it("resolves the retained MiniMax provider in scope", () => {
    const imported = credential();
    readMiniMaxCliCredentialsCached.mockReturnValue(imported);

    expect(resolveExternalCliAuthProfiles(store(), { providerIds: ["minimax"] })).toEqual([
      { profileId, credential: imported, persistence: "persisted" },
    ]);
    expect(readMiniMaxCliCredentialsCached).toHaveBeenCalledWith({ ttlMs: 15 * 60 * 1000 });
  });

  it("does not read the retained CLI outside its provider scope", () => {
    expect(resolveExternalCliAuthProfiles(store(), { providerIds: ["openai"] })).toEqual([]);
    expect(readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("keeps a usable local MiniMax profile ahead of its external CLI", () => {
    const local = credential({ access: "local-access", refresh: "local-refresh" });
    readMiniMaxCliCredentialsCached.mockReturnValue(
      credential({ access: "fresh-access", refresh: "fresh-refresh" }),
    );

    expect(
      resolveExternalCliAuthProfiles(store({ [profileId]: local }), {
        providerIds: ["minimax-portal"],
      }),
    ).toEqual([]);
  });

  it("allows the generic OAuth bootstrap callback for the retained provider", () => {
    const imported = credential({ access: "imported-access", refresh: "imported-refresh" });
    readMiniMaxCliCredentialsCached.mockReturnValue(imported);

    expect(
      readExternalCliBootstrapCredential({
        store: store(),
        profileId,
        credential: credential({ access: "", refresh: "", expires: 0 }),
      }),
    ).toEqual(imported);
  });
});
