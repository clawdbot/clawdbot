import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SecretsStoreListResultSchema,
  SecretsStoreMutationResultSchema,
  SecretsStoreSetParamsSchema,
} from "./secrets.js";

const metadata = {
  name: "SERVICE_API_KEY",
  scopeKind: "team",
  scopeId: "",
  createdAtMs: 1,
  updatedAtMs: 2,
  updatedBy: "Operator",
};

describe("secret store protocol schemas", () => {
  it("makes secret values structurally unrepresentable while requiring env values", () => {
    expect(
      Value.Check(SecretsStoreListResultSchema, {
        entries: [
          { ...metadata, kind: "secret" },
          { ...metadata, name: "SERVICE_URL", kind: "env", value: "https://service.test" },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsStoreListResultSchema, {
        entries: [{ ...metadata, kind: "secret", value: "must-not-cross-boundary" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(SecretsStoreListResultSchema, {
        entries: [{ ...metadata, name: "SERVICE_URL", kind: "env" }],
      }),
    ).toBe(false);
  });

  it("validates store mutations and their reload status", () => {
    expect(
      Value.Check(SecretsStoreSetParamsSchema, {
        name: "SERVICE_API_KEY",
        value: "value",
        kind: "secret",
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsStoreSetParamsSchema, {
        name: "lowercase",
        value: "value",
        kind: "secret",
      }),
    ).toBe(false);
    expect(
      Value.Check(SecretsStoreMutationResultSchema, {
        ok: true,
        reloaded: true,
        warningCount: 1,
      }),
    ).toBe(true);
  });
});
