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

  it("keeps an implicit store ref unknown until runtime resolution", () => {
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "api_key",
          provider: "test",
          keyRef: { source: "store", provider: "default", id: "STORED_API_KEY" },
        },
        cfg: {},
        env: {},
      }),
    ).toBeUndefined();
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
