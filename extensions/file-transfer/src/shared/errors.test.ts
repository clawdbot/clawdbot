import { describe, expect, it } from "vitest";
import { classifyFsError, err, throwFromNodePayload } from "./errors.js";

describe("err", () => {
  it("returns an error envelope without canonicalPath when omitted", () => {
    const e = err("INVALID_PATH", "path required");
    expect(e).toEqual({ ok: false, code: "INVALID_PATH", message: "path required" });
    expect("canonicalPath" in e).toBe(false);
  });

  it("includes canonicalPath only when provided non-empty", () => {
    const withPath = err("NOT_FOUND", "missing", "/tmp/x");
    expect(withPath.canonicalPath).toBe("/tmp/x");

    const blankPath = err("NOT_FOUND", "missing", "");
    expect("canonicalPath" in blankPath).toBe(false);
  });
});

describe("classifyFsError", () => {
  it("maps ENOENT to NOT_FOUND", () => {
    expect(classifyFsError({ code: "ENOENT" })).toBe("NOT_FOUND");
  });

  it("maps EACCES and EPERM to PERMISSION_DENIED", () => {
    expect(classifyFsError({ code: "EACCES" })).toBe("PERMISSION_DENIED");
    expect(classifyFsError({ code: "EPERM" })).toBe("PERMISSION_DENIED");
  });

  it("maps EISDIR to IS_DIRECTORY", () => {
    expect(classifyFsError({ code: "EISDIR" })).toBe("IS_DIRECTORY");
  });

  it("falls back to READ_ERROR for unknown / null / non-object input", () => {
    expect(classifyFsError({ code: "EUNKNOWN" })).toBe("READ_ERROR");
    expect(classifyFsError(null)).toBe("READ_ERROR");
    expect(classifyFsError(undefined)).toBe("READ_ERROR");
    expect(classifyFsError("nope")).toBe("READ_ERROR");
  });
});

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
