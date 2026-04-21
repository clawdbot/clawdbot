import { describe, expect, it } from "vitest";
import { parseSoftResetCommand } from "./commands-reset-mode.js";

describe("parseSoftResetCommand", () => {
  it("matches /reset soft with or without a tail", () => {
    expect(parseSoftResetCommand("/reset soft")).toEqual({ matched: true, tail: "" });
    expect(parseSoftResetCommand("/reset soft re-read persona files")).toEqual({
      matched: true,
      tail: "re-read persona files",
    });
    expect(parseSoftResetCommand("/reset soft\tre-read persona files")).toEqual({
      matched: true,
      tail: "re-read persona files",
    });
    expect(parseSoftResetCommand("/reset soft\nre-read persona files")).toEqual({
      matched: true,
      tail: "re-read persona files",
    });
  });

  it("rejects reset-prefixed typos without a command boundary", () => {
    expect(parseSoftResetCommand("/resetsoft")).toEqual({ matched: false });
    expect(parseSoftResetCommand("/resetsoft hello")).toEqual({ matched: false });
  });
});
