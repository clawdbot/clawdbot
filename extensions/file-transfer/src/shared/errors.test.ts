// File Transfer tests cover errors plugin behavior.
import { describe, expect, it } from "vitest";
import { throwFromNodePayload } from "./errors.js";

describe("throwFromNodePayload", () => {
  it("preserves code and message in the thrown Error", () => {
    expect(() =>
      throwFromNodePayload("file.fetch", { code: "NOT_FOUND", message: "file not found" }),
    ).toThrow(/file\.fetch NOT_FOUND: file not found/);
  });

  it("appends canonicalPath when present", () => {
    expect(() =>
      throwFromNodePayload("file.fetch", {
        code: "POLICY_DENIED",
        message: "blocked",
        canonicalPath: "/tmp/x",
      }),
    ).toThrow(/canonical=\/tmp\/x/);
  });

  it("falls back to ERROR / generic message when fields are missing", () => {
    expect(() => throwFromNodePayload("dir.list", {})).toThrow(/dir\.list ERROR: dir\.list failed/);
  });
});
