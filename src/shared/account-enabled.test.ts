// Tests for account enabled guard.
import { describe, expect, it } from "vitest";
import { isAccountEnabled } from "./account-enabled.js";

describe("isAccountEnabled", () => {
  it("returns true when enabled is true", () => {
    expect(isAccountEnabled({ enabled: true })).toBe(true);
  });

  it("returns false when enabled is false", () => {
    expect(isAccountEnabled({ enabled: false })).toBe(false);
  });

  it("returns true when enabled is undefined", () => {
    expect(isAccountEnabled({ enabled: undefined })).toBe(true);
  });

  it("returns true for object without enabled field", () => {
    expect(isAccountEnabled({ name: "test" })).toBe(true);
  });

  it("returns true when enabled is null", () => {
    expect(isAccountEnabled({ enabled: null })).toBe(true);
  });

  it("returns true for null account", () => {
    expect(isAccountEnabled(null)).toBe(true);
  });

  it("returns true for undefined account", () => {
    expect(isAccountEnabled(undefined)).toBe(true);
  });

  it("returns true for string account", () => {
    expect(isAccountEnabled("account-name")).toBe(true);
  });

  it("returns true for empty object", () => {
    expect(isAccountEnabled({})).toBe(true);
  });
});
