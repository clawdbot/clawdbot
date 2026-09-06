import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveStoredCredentialReadOnlyAvailability } from "./read-only-availability.js";

const cfg = {
  secrets: {
    providers: {
      vault: { source: "env" },
    },
  },
} satisfies OpenClawConfig;

describe("resolveStoredCredentialReadOnlyAvailability", () => {
  it.each([
    {
      name: "present selected env",
      selected: true,
      env: { COLLISION_KEY: "synthetic-key" },
      expected: true,
    },
    { name: "missing selected env", selected: true, env: {}, expected: undefined },
    {
      name: "non-default mismatch",
      selected: false,
      env: { COLLISION_KEY: "synthetic-key" },
      expected: false,
    },
  ])("preserves availability for $name under a file collision", ({ selected, env, expected }) => {
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "api_key",
          provider: "test",
          key: "retained-inline-key",
          keyRef: { source: "env", provider: "selected", id: "COLLISION_KEY" },
        },
        cfg: {
          secrets: {
            defaults: selected ? { env: "selected" } : undefined,
            providers: { selected: { source: "file", path: "/unused" } },
          },
        },
        env,
      }),
    ).toBe(expected);
  });

  describe.each(["api_key", "token"] as const)("%s store refs", (type) => {
    it.each<{
      name: string;
      provider: string;
      secrets?: OpenClawConfig["secrets"];
      expected: boolean | undefined;
    }>([
      { name: "implicit default", provider: "default", expected: undefined },
      {
        name: "selected default without a declaration",
        provider: "shared",
        secrets: { defaults: { store: "shared" } },
        expected: undefined,
      },
      ...(
        [
          { source: "file", path: "/tmp/unused-store-alias-fixture.json" },
          { source: "env" },
          { source: "exec", command: "/tmp/unused-store-alias-command" },
        ] as const
      ).map((provider) => ({
        name: `selected default shadowing ${provider.source}`,
        provider: "shared",
        secrets: { defaults: { store: "shared" }, providers: { shared: provider } },
        expected: undefined,
      })),
      {
        name: "explicit matching non-default provider",
        provider: "shared",
        secrets: { providers: { shared: { source: "store" } } },
        expected: undefined,
      },
      { name: "missing non-default provider", provider: "shared", expected: false },
      {
        name: "mismatched non-default provider",
        provider: "shared",
        secrets: { providers: { shared: { source: "file", path: "/tmp/unused.json" } } },
        expected: false,
      },
      {
        name: "old default after selecting another alias",
        provider: "default",
        secrets: { defaults: { store: "shared" } },
        expected: false,
      },
    ])("classifies $name without resolving it", ({ provider, secrets, expected }) => {
      const ref = { source: "store", provider, id: "STORED_API_KEY" } as const;
      expect(
        resolveStoredCredentialReadOnlyAvailability({
          credential:
            type === "api_key"
              ? { type, provider: "test", key: "retained-inline", keyRef: ref }
              : { type, provider: "test", token: "retained-inline", tokenRef: ref },
          cfg: { secrets },
          env: {},
        }),
      ).toBe(expected);
    });
  });

  it("prefers explicit secret refs over retained inline values", () => {
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "api_key",
          provider: "test",
          key: "kept",
          keyRef: { source: "env", provider: "vault", id: "MISSING_KEY" },
        },
        cfg,
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "token",
          provider: "test",
          token: "kept",
          tokenRef: { source: "env", provider: "vault", id: "MISSING_TOKEN" },
        },
        cfg,
        env: {},
      }),
    ).toBeUndefined();
  });

  it("rejects expired static tokens before checking their secret ref", () => {
    const now = Date.now();
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "token",
          provider: "test",
          token: "kept",
          tokenRef: { source: "env", provider: "vault", id: "MISSING_TOKEN" },
          expires: now,
        },
        cfg,
        env: {},
        now,
      }),
    ).toBe(false);
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "token",
          provider: "test",
          token: "kept",
          expires: "invalid" as never,
        },
        cfg,
        env: {},
        now,
      }),
    ).toBe(false);
  });

  it("requires an explicit provider refresh capability for refresh-only OAuth", () => {
    const credential = {
      type: "oauth" as const,
      provider: "test",
      access: "",
      refresh: "refresh",
      expires: 0,
    };
    expect(
      resolveStoredCredentialReadOnlyAvailability({ credential, cfg, env: {} }),
    ).toBeUndefined();
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential,
        cfg,
        env: {},
        canRefreshOAuth: true,
      }),
    ).toBe(true);
  });
});
