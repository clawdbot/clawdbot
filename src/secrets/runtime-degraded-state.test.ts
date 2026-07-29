/** Tests for process-local SecretRef degraded-owner state. */
import { afterEach, describe, expect, it } from "vitest";
import {
  associateSecretResolutionErrorOwners,
  assertSecretOwnerAvailable,
  clearActiveCredentialDegradedOwner,
  listActiveDegradedSecretOwners,
  listSecretResolutionErrorOwners,
  SecretSurfaceUnavailableError,
  setActiveCredentialDegradedOwner,
  setActiveDegradedSecretOwners,
} from "./runtime-degraded-state.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("runtime degraded SecretRef owners", () => {
  it("publishes cloned owner snapshots and throws the typed unavailable error", () => {
    const owner = {
      ownerKind: "provider" as const,
      ownerId: "openai",
      state: "unavailable" as const,
      paths: ["models.providers.openai.apiKey"],
      refKeys: ["env:default:OPENAI_API_KEY"],
      reason: "secret reference was not found",
    };
    setActiveDegradedSecretOwners([owner]);
    owner.paths.push("mutated");

    expect(listActiveDegradedSecretOwners()).toEqual([
      expect.objectContaining({ paths: ["models.providers.openai.apiKey"] }),
    ]);
    expect(() => assertSecretOwnerAvailable("provider", "openai")).toThrowError(
      SecretSurfaceUnavailableError,
    );
    expect(() => assertSecretOwnerAvailable("provider", "openai")).toThrow(
      "Secret owner provider:openai is configured but unavailable",
    );
    expect(() => assertSecretOwnerAvailable("provider", "anthropic")).not.toThrow();
  });
  it("records strict resolution owner metadata without exposing mutable state", () => {
    const error = new Error("private provider details");
    const owner = {
      ownerKind: "provider" as const,
      ownerId: "openai",
      state: "unavailable" as const,
      paths: ["models.providers.openai.apiKey"],
      refKeys: ["env:default:OPENAI_API_KEY"],
      reason: "secret provider failed",
      degradationState: "stale" as const,
      failureMatched: true,
      source: "config" as const,
    };
    associateSecretResolutionErrorOwners(error, [owner]);

    const recorded = listSecretResolutionErrorOwners(error);
    recorded[0]?.paths.push("mutated");
    expect(listSecretResolutionErrorOwners(error)[0]?.paths).toEqual([
      "models.providers.openai.apiKey",
    ]);
  });

  it("reports stale owners without blocking their last-known-good runtime", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        degradationState: "stale",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_API_KEY"],
        reason: "secret reference was not found",
      },
    ]);

    expect(listActiveDegradedSecretOwners()).toMatchObject([
      { ownerId: "openai", degradationState: "stale" },
    ]);
    expect(() => assertSecretOwnerAvailable("provider", "openai")).not.toThrow();
  });

  it("merges runtime-discovered credential owners and clears them independently", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_API_KEY"],
        reason: "secret reference was not found",
      },
    ]);
    setActiveCredentialDegradedOwner({
      ownerKind: "account",
      ownerId: "telegram:work",
      state: "unavailable",
      paths: ["channels.telegram.accounts.work.tokenFile"],
      refKeys: [],
      reason: "credential file is unavailable",
    });

    expect(listActiveDegradedSecretOwners().map((owner) => owner.ownerId)).toEqual([
      "openai",
      "telegram:work",
    ]);

    clearActiveCredentialDegradedOwner("account", "telegram:work");

    expect(listActiveDegradedSecretOwners().map((owner) => owner.ownerId)).toEqual(["openai"]);
  });
});
