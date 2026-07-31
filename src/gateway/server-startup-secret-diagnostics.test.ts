/** Tests Gateway aggregation of provider-scoped SecretRef diagnostics. */
import { describe, expect, it, vi } from "vitest";
import { logPreparedSecretDegradations } from "./server-startup-secret-diagnostics.js";

describe("Gateway SecretRef diagnostics", () => {
  it("includes a multi-provider owner in every provider diagnostic", () => {
    const warn = vi.fn();

    logPreparedSecretDegradations({ info: vi.fn(), warn }, [
      {
        ownerKind: "provider",
        ownerId: "example",
        state: "unavailable",
        degradationState: "cold",
        paths: ["models.providers.example.apiKey", "models.providers.example.headers.X-Secondary"],
        refKeys: ["exec:first:api-key", "exec:second:secondary"],
        reason: "secret provider failed",
        providerFailures: [
          { source: "exec", provider: "first" },
          { source: "exec", provider: "second" },
        ],
      },
    ]);

    expect(warn).toHaveBeenCalledTimes(2);
    for (const provider of ["first", "second"]) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`[SECRETS_PROVIDER_DEGRADED] exec:${provider}`),
        expect.objectContaining({
          event: "secrets.provider_degraded",
          provider,
          affectedOwners: [{ ownerKind: "provider", ownerId: "example", state: "cold" }],
        }),
      );
    }
  });

  it("keeps an owner diagnostic when provider and ref failures are mixed", () => {
    const warn = vi.fn();

    logPreparedSecretDegradations({ info: vi.fn(), warn }, [
      {
        ownerKind: "provider",
        ownerId: "example",
        state: "unavailable",
        degradationState: "cold",
        paths: ["models.providers.example.apiKey"],
        refKeys: ["exec:vault:api-key"],
        reason: "secret reference was not found",
        providerFailures: [{ source: "exec", provider: "vault" }],
        refFailureReason: "secret reference was not found",
      },
    ]);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[SECRETS_DEGRADED] cold provider:example"),
      expect.objectContaining({
        event: "secrets.degraded",
        reason: "secret reference was not found",
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[SECRETS_PROVIDER_DEGRADED] exec:vault"),
      expect.objectContaining({
        event: "secrets.provider_degraded",
        reason: "secret provider failed",
      }),
    );
  });
});
