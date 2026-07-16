import { describe, expect, it } from "vitest";
import { isPersistentBrowserProfileMutation } from "./request-policy.js";

describe("isPersistentBrowserProfileMutation", () => {
  it.each([
    ["POST", "/profiles/create"],
    ["POST", "profiles/create"],
    ["POST", "/reset-profile"],
    ["POST", "reset-profile"],
    ["DELETE", "/profiles/poc"],
  ])("treats %s %s as a persistent profile mutation", (method, path) => {
    expect(isPersistentBrowserProfileMutation(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/profiles"],
    ["GET", "/profiles/poc"],
    ["GET", "/status"],
    ["POST", "/stop"],
    ["DELETE", "/profiles"],
    ["DELETE", "/profiles/poc/tabs"],
  ])("allows non-mutating browser routes for %s %s", (method, path) => {
    expect(isPersistentBrowserProfileMutation(method, path)).toBe(false);
  });
});
