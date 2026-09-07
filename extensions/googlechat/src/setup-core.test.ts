import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveGoogleChatAccount, resolveGoogleChatConfigAccessorAccount } from "./accounts.js";
import { googlechatSetupAdapter } from "./setup-core.js";

type GoogleChatChannelConfig = {
  serviceAccount?: string;
  serviceAccountFile?: string;
  accounts?: Record<
    string,
    { serviceAccount?: string; serviceAccountFile?: string; name?: string }
  >;
};

function applyGoogleChatSetup(
  input: Record<string, unknown>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): OpenClawConfig {
  return googlechatSetupAdapter.applyAccountConfig({ cfg, accountId: "default", input });
}

function appliedGoogleChatConfig(
  input: Record<string, unknown>,
  cfg?: OpenClawConfig,
): GoogleChatChannelConfig {
  return (applyGoogleChatSetup(input, cfg).channels?.googlechat ?? {}) as GoogleChatChannelConfig;
}

describe("googlechat credential rotation", () => {
  // Inline serviceAccount wins over serviceAccountFile at resolution time, so a
  // rotation that leaves it behind silently keeps using the credential — and its
  // plaintext private key — that it was meant to replace.
  it("retires an inline service account when a file replaces it", () => {
    const fromInline = applyGoogleChatSetup({ token: '{"type":"service_account"}' });

    const rotated = appliedGoogleChatConfig(
      { tokenFile: "/run/secrets/googlechat-sa.json" },
      fromInline,
    );

    expect(rotated.serviceAccountFile).toBe("/run/secrets/googlechat-sa.json");
    expect(rotated.serviceAccount).toBeUndefined();
  });

  it("retires a service account file when an inline value replaces it", () => {
    const fromFile = applyGoogleChatSetup({ tokenFile: "/run/secrets/googlechat-sa.json" });

    const rotated = appliedGoogleChatConfig({ token: '{"type":"service_account"}' }, fromFile);

    expect(rotated.serviceAccount).toBe('{"type":"service_account"}');
    expect(rotated.serviceAccountFile).toBeUndefined();
  });

  it("retires both sources when switching to the environment", () => {
    const fromInline = applyGoogleChatSetup({ token: '{"type":"service_account"}' });

    const rotated = appliedGoogleChatConfig({ useEnv: true }, fromInline);

    expect(rotated.serviceAccount).toBeUndefined();
    expect(rotated.serviceAccountFile).toBeUndefined();
  });

  it("retires a promoted accounts.default credential so the rotation wins at resolution", () => {
    // Named-account setup promotes the root credential into accounts.default,
    // and the merged account config reads that record ahead of the root fields.
    const promoted = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            default: { serviceAccount: '{"type":"service_account","old":true}', name: "Main" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotatedConfig = applyGoogleChatSetup({ token: '{"type":"service_account"}' }, promoted);
    const rotated = (rotatedConfig.channels?.googlechat ?? {}) as GoogleChatChannelConfig;

    expect(rotated.serviceAccount).toBe('{"type":"service_account"}');
    expect(rotated.accounts?.default?.serviceAccount).toBeUndefined();
    expect(rotated.accounts?.default?.name).toBe("Main");
    expect(
      resolveGoogleChatConfigAccessorAccount({ cfg: rotatedConfig }).config.serviceAccount,
    ).toBe('{"type":"service_account"}');
  });

  it("does not select the root identity when a named-account rotation retires its inline override", () => {
    // Root carries the default account's inline credential A. The named account
    // `work` explicitly sets inline B. Rotating `work` to a file retires B and
    // writes the file, but the account merger still inherits root A into the
    // named account; the resolver would pick A (the wrong identity) unless the
    // account's explicit credential source is treated as an atomic override.
    const cfg = {
      channels: {
        googlechat: {
          enabled: true,
          serviceAccount: '{"type":"service_account","v":"A"}',
          accounts: {
            work: {
              serviceAccount: '{"type":"service_account","v":"B"}',
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = googlechatSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "work",
      input: { tokenFile: "/run/secrets/work-sa.json" },
    });
    const resolved = resolveGoogleChatAccount({ cfg: rotated, accountId: "work" });

    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/run/secrets/work-sa.json");
  });

  it("does not select the root identity when a named-account rotation replaces its file with inline", () => {
    // Mirror case: root inline A + named account file F. Rotating `work` to
    // inline B writes the account-level inline and retires the file; the root
    // inline A must not win over the account's explicit B.
    const cfg = {
      channels: {
        googlechat: {
          enabled: true,
          serviceAccount: '{"type":"service_account","v":"A"}',
          accounts: {
            work: {
              serviceAccountFile: "/run/secrets/work-sa.json",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotated = googlechatSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "work",
      input: { token: '{"type":"service_account","v":"B"}' },
    });
    const resolved = resolveGoogleChatAccount({ cfg: rotated, accountId: "work" });

    expect(resolved.credentialSource).toBe("inline");
    expect(resolved.credentials).toMatchObject({ v: "B" });
  });

  it("keeps the legitimate root fallback for a named account with no explicit credential", () => {
    // A named account that sets no credential source still inherits the root
    // credential through the account merger — that fallback is intentional and
    // must not be treated as an explicit override.
    const cfg = {
      channels: {
        googlechat: {
          enabled: true,
          serviceAccount: '{"type":"service_account","v":"A"}',
          accounts: {
            work: {
              name: "Work Team",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "work" });

    expect(resolved.credentialSource).toBe("inline");
    expect(resolved.credentials).toMatchObject({ v: "A" });
  });

  it("keeps the default-account credential isolation for a named account with a file", () => {
    // A named account's explicit file must not inherit the default account's
    // inline credential (mirrors the resolver-level isolation test).
    const cfg = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            default: {
              serviceAccount: { source: "env", provider: "test", id: "default-sa" },
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            work: {
              serviceAccountFile: "/run/secrets/work-sa.json",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "work" });

    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/run/secrets/work-sa.json");
    expect(resolved.config.audienceType).toBe("app-url");
  });
});
