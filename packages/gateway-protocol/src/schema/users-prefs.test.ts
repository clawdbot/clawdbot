import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  UsersPrefsGetResultSchema,
  UsersPrefsSetResultSchema,
  validateUsersPrefsGetParams,
  validateUsersPrefsSetParams,
} from "../index.js";

describe("user preference protocol schemas", () => {
  it("bounds self-scoped preference requests", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key-${index}`, { index }]),
    );
    expect(validateUsersPrefsGetParams({})).toBe(true);
    expect(validateUsersPrefsGetParams({ keys: Object.keys(entries) })).toBe(true);
    expect(validateUsersPrefsSetParams({ entries })).toBe(true);
    expect(validateUsersPrefsGetParams({ keys: [...Object.keys(entries), "overflow"] })).toBe(
      false,
    );
    expect(validateUsersPrefsGetParams({ keys: ["same", "same"] })).toBe(false);
    expect(validateUsersPrefsSetParams({ entries: { ...entries, overflow: true } })).toBe(false);
  });

  it("keeps no-identity results distinct from successful values", () => {
    expect(Value.Check(UsersPrefsGetResultSchema, { status: "no_durable_identity" })).toBe(true);
    expect(
      Value.Check(UsersPrefsGetResultSchema, { status: "ok", entries: { theme: "claw" } }),
    ).toBe(true);
    expect(Value.Check(UsersPrefsSetResultSchema, { status: "ok" })).toBe(true);
    expect(Value.Check(UsersPrefsSetResultSchema, { status: "no_durable_identity" })).toBe(true);
  });
});
