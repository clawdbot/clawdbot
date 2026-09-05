import type { ResolverContext } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { describe, expect, it } from "vitest";
import {
  channelSecrets,
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "../secret-contract-api.js";

function collect(enabled: boolean, apiKey: unknown) {
  const config = { channels: { reef: { enabled, guard: { apiKey } } } };
  const context: ResolverContext = {
    sourceConfig: config,
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
  collectRuntimeConfigAssignments({ config, context });
  return { config, context };
}

describe("Reef guard SecretRef contract", () => {
  const ref = { source: "file", provider: "guard", id: "value" };

  it("exposes the guard credential to standard secret audit and configure tools", () => {
    expect(channelSecrets.collectRuntimeConfigAssignments).toBe(collectRuntimeConfigAssignments);
    expect(secretTargetRegistryEntries).toEqual([
      expect.objectContaining({
        pathPattern: "channels.reef.guard.apiKey",
        secretShape: "secret_input",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      }),
    ]);
  });

  it("isolates the Reef account and applies only its resolved guard credential", () => {
    const { config, context } = collect(true, ref);
    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({
      path: "channels.reef.guard.apiKey",
      ref,
      ownerKind: "account",
      ownerId: "reef:default",
      requiredForGateway: false,
      disposition: "isolate",
    });
    context.assignments[0]!.apply("resolved-fixture-key");
    expect(config.channels.reef.guard.apiKey).toBe("resolved-fixture-key");
  });

  it("does not resolve disabled Reef credentials or treat literal broker markers as references", () => {
    const disabled = collect(false, ref).context;
    expect(disabled.assignments).toHaveLength(0);
    expect(disabled.warnings).toEqual([
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.reef.guard.apiKey",
      }),
    ]);
    expect(collect(true, "broker-marker").context.assignments).toHaveLength(0);
  });
});
