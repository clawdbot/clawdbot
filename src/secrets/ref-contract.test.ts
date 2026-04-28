import { describe, expect, it } from "vitest";
import {
  INVALID_FILE_SECRET_REF_IDS,
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_FILE_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  validateExecSecretRefId,
} from "./ref-contract.js";

describe("file secret ref id validation", () => {
  it("accepts valid file secret ref ids", () => {
    for (const id of VALID_FILE_SECRET_REF_IDS) {
      expect(isValidFileSecretRefId(id), `expected valid id: ${id}`).toBe(true);
    }
  });

  it("rejects invalid file secret ref ids", () => {
    for (const id of INVALID_FILE_SECRET_REF_IDS) {
      expect(isValidFileSecretRefId(id), `expected invalid id: ${id}`).toBe(false);
    }
  });
});

describe("exec secret ref id validation", () => {
  it("accepts valid exec secret ref ids", () => {
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      expect(isValidExecSecretRefId(id), `expected valid id: ${id}`).toBe(true);
      expect(validateExecSecretRefId(id)).toEqual({ ok: true });
    }
  });

  it("rejects invalid exec secret ref ids", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      expect(isValidExecSecretRefId(id), `expected invalid id: ${id}`).toBe(false);
      expect(validateExecSecretRefId(id).ok).toBe(false);
    }
  });

  it("reports traversal segment failures separately", () => {
    expect(validateExecSecretRefId("a/../b")).toEqual({
      ok: false,
      reason: "traversal-segment",
    });
    expect(validateExecSecretRefId("a/./b")).toEqual({
      ok: false,
      reason: "traversal-segment",
    });
  });
});
