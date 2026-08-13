import { describe, expect, it } from "vitest";
import { collectRuntimeSecretInputAssignment, createResolverContext } from "./runtime-shared.js";

describe("runtime secret assignments", () => {
  it("keeps legacy plugin owners without contracts conservatively unbound", () => {
    const context = createResolverContext({ sourceConfig: {}, env: {} });

    collectRuntimeSecretInputAssignment({
      value: { source: "env", provider: "default", id: "FIXTURE_LEGACY" },
      path: "plugins.entries.example.config.apiKey",
      expected: "string",
      defaults: undefined,
      context,
      owner: {
        ownerKind: "capability",
        ownerId: "example",
        requiredForGateway: false,
        disposition: "isolate",
      },
      apply: () => undefined,
    });

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]?.ownerContractDigest).toBeUndefined();
  });
});
