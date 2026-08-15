/** Upgrade path: pre-identity claude-cli profiles gain the CLI account email. */
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const readClaudeCliCredentialsCachedMock = vi.fn();

vi.mock("../cli-credentials.js", async (importActual) => {
  const actual = await importActual<typeof import("../cli-credentials.js")>();
  return {
    ...actual,
    readClaudeCliCredentialsCached: readClaudeCliCredentialsCachedMock,
  };
});

const { resolveExternalCliAuthProfiles } = await import("./external-cli-sync.js");

function refreshFixture(): string {
  return ["stored", "refresh"].join("-");
}

function storeWithClaudeProfile(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:claude-cli": {
        type: "oauth",
        provider: "claude-cli",
        access: ["stored", "access"].join("-"),
        refresh: refreshFixture(),
        expires: Date.now() + 3_600_000,
      },
    },
  } as unknown as AuthProfileStore;
}

describe("external cli sync email backfill", () => {
  it("backfills the email onto a usable stored profile from the same login", () => {
    readClaudeCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: ["rotated", "access"].join("-"),
      refresh: refreshFixture(),
      expires: Date.now() + 3_600_000,
      email: "cli-login@example.com",
    });

    const profiles = resolveExternalCliAuthProfiles(storeWithClaudeProfile());

    const backfilledEmail = "cli-login@example.com";
    expect(profiles).toEqual([
      {
        profileId: "anthropic:claude-cli",
        credential: expect.objectContaining({ email: backfilledEmail }),
        persistence: "persisted",
      },
    ]);
  });

  it("does not backfill from a different CLI login", () => {
    readClaudeCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: ["other", "access"].join("-"),
      refresh: ["other", "refresh"].join("-"),
      expires: Date.now() + 3_600_000,
      email: "someone-else@example.com",
    });

    expect(resolveExternalCliAuthProfiles(storeWithClaudeProfile())).toEqual([]);
  });
});
