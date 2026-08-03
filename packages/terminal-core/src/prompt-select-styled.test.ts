// Terminal Core tests cover prompt select styled behavior.
import { describe, expect, it } from "vitest";
import { styleSelectParams } from "./prompt-select-styled-params.js";

describe("styleSelectParams", () => {
  it("styles messages and hints without replacing unhinted options", () => {
    const option = { value: "dev", label: "Dev" };
    const params = styleSelectParams(
      {
        message: "Pick channel",
        options: [{ value: "stable", label: "Stable", hint: "Tagged releases" }, option],
      },
      {
        message: (value) => `msg:${value}`,
        hint: (value) => `hint:${value}`,
      },
    );

    expect(params).toEqual({
      message: "msg:Pick channel",
      options: [
        { value: "stable", label: "Stable", hint: "hint:Tagged releases" },
        { value: "dev", label: "Dev" },
      ],
    });
    expect(params.options[1]).toBe(option);
  });
});
