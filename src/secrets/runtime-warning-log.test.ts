/** Tests warning suppression when provider failures have aggregate Gateway diagnostics. */
import { describe, expect, it, vi } from "vitest";
import { logRuntimeSecretWarnings } from "./runtime-warning-log.js";

function snapshot(refFailureReason?: string) {
  const path = "models.providers.example.apiKey";
  return {
    warnings: [
      {
        code: "SECRETS_OWNER_UNAVAILABLE" as const,
        path,
        message: "Secret owner provider:example is configured-unavailable.",
      },
    ],
    degradedOwners: [
      {
        ownerKind: "provider" as const,
        ownerId: "example",
        state: "unavailable" as const,
        paths: [path],
        refKeys: ["exec:vault:api-key"],
        reason: refFailureReason ?? "secret provider failed",
        providerFailures: [{ source: "exec" as const, provider: "vault" }],
        ...(refFailureReason ? { refFailureReason } : {}),
      },
    ],
  };
}

describe("runtime SecretRef warning logging", () => {
  it("suppresses per-owner warnings for a pure provider outage", () => {
    const warn = vi.fn();
    logRuntimeSecretWarnings({ snapshot: snapshot(), log: { warn }, ownerUnavailable: "include" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("retains per-owner warnings when a ref failure is also present", () => {
    const warn = vi.fn();
    logRuntimeSecretWarnings({
      snapshot: snapshot("secret reference was not found"),
      log: { warn },
      ownerUnavailable: "include",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
