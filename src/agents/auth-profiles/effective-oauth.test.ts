import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveOAuthCredential } from "./effective-oauth.js";
import type { OAuthCredential } from "./types.js";

const mocks = vi.hoisted(() => ({
  readManagedExternalCliCredential: vi.fn<() => OAuthCredential | null>(() => null),
}));

vi.mock("./external-cli-sync.js", () => ({
  readManagedExternalCliCredential: mocks.readManagedExternalCliCredential,
}));

function makeCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "local-access-token",
    refresh: "local-refresh-token",
    expires: Date.now() - 60_000,
    ...overrides,
  };
}

describe("resolveEffectiveOAuthCredential", () => {
  beforeEach(() => {
    mocks.readManagedExternalCliCredential.mockReset().mockReturnValue(null);
  });

  it("uses external cli oauth only when local credentials are unusable and safe to bootstrap", () => {
    const imported = makeCredential({
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    mocks.readManagedExternalCliCredential.mockReturnValue(imported);

    expect(
      resolveEffectiveOAuthCredential({
        profileId: "openai-codex:default",
        credential: makeCredential(),
      }),
    ).toBe(imported);
  });

  it("keeps healthy local oauth over fresher external cli credentials", () => {
    const imported = makeCredential({
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() + 24 * 60 * 60_000,
    });
    const local = makeCredential({
      access: "healthy-local-access-token",
      refresh: "healthy-local-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    mocks.readManagedExternalCliCredential.mockReturnValue(imported);

    expect(
      resolveEffectiveOAuthCredential({
        profileId: "openai-codex:default",
        credential: local,
      }),
    ).toBe(local);
  });

  it("refuses mismatched external cli oauth identities", () => {
    const local = makeCredential({ accountId: "acct-local" });
    const imported = makeCredential({
      access: "fresh-cli-access-token",
      expires: Date.now() + 30 * 60_000,
      accountId: "acct-external",
    });
    mocks.readManagedExternalCliCredential.mockReturnValue(imported);

    expect(
      resolveEffectiveOAuthCredential({
        profileId: "openai-codex:default",
        credential: local,
      }),
    ).toBe(local);
  });
});
