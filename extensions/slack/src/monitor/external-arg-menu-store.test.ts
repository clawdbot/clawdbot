import { describe, expect, it } from "vitest";
import {
  createSlackExternalArgMenuStore,
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
} from "./external-arg-menu-store.js";

describe("createSlackExternalArgMenuStore", () => {
  const choices = [{ label: "Daily", value: "day" }];

  it("returns entries before their expiry", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 1_700_000_000_000);

    expect(store.get(token, 1_700_000_001_000)).toEqual({
      choices,
      userId: "U1",
      expiresAt: 1_700_000_600_000,
    });
  });

  it("drops entries when the current clock is not a valid date timestamp", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 1_700_000_000_000);

    expect(store.get(token, Number.NaN)).toBeUndefined();
    expect(store.get(token, 1_700_000_001_000)).toBeUndefined();
  });

  it("does not retain entries when expiry would exceed the valid date range", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 8_640_000_000_000_000);

    expect(store.get(token, 1_700_000_001_000)).toBeUndefined();
  });

  it("reads only prefixed valid menu tokens", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 1_700_000_000_000);

    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${token}`)).toBe(token);
    expect(store.readToken(token)).toBeUndefined();
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}not a token`)).toBeUndefined();
  });
});
