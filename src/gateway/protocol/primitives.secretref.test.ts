import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../../test-utils/secret-ref-test-vectors.js";
import { SecretInputSchema, SecretRefSchema } from "./schema/primitives.js";

describe("gateway protocol SecretRef schema", () => {
  const validateSecretRef = Compile(SecretRefSchema);
  const validateSecretInput = Compile(SecretInputSchema);

  it("accepts valid source-specific refs", () => {
    expect(
      validateSecretRef.Check({ source: "env", provider: "default", id: "OPENAI_API_KEY" }),
    ).toBe(true);
    expect(
      validateSecretRef.Check({
        source: "file",
        provider: "filemain",
        id: "/providers/openai/apiKey",
      }),
    ).toBe(true);
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      expect(validateSecretRef.Check({ source: "exec", provider: "vault", id }), id).toBe(true);
      expect(validateSecretInput.Check({ source: "exec", provider: "vault", id }), id).toBe(true);
    }
  });

  it("rejects invalid exec refs", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      expect(validateSecretRef.Check({ source: "exec", provider: "vault", id }), id).toBe(false);
      expect(validateSecretInput.Check({ source: "exec", provider: "vault", id }), id).toBe(false);
    }
  });
});
