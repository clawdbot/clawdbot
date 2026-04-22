import { afterEach, describe, expect, it } from "vitest";
import { isEmbeddedMode, setEmbeddedMode } from "./embedded-mode.js";

describe("embedded-mode flag", () => {
  afterEach(() => {
    setEmbeddedMode(false);
  });

  it("defaults to false", () => {
    expect(isEmbeddedMode()).toBe(false);
  });

  it("can be set to true", () => {
    setEmbeddedMode(true);
    expect(isEmbeddedMode()).toBe(true);
  });

  it("can be toggled back to false", () => {
    setEmbeddedMode(true);
    expect(isEmbeddedMode()).toBe(true);

    setEmbeddedMode(false);
    expect(isEmbeddedMode()).toBe(false);
  });
});
