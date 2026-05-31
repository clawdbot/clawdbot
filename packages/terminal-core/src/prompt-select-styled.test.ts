import { describe, expect, it } from "vitest";
import { styleSelectParams } from "./prompt-select-styled-params.js";

describe("styleSelectParams", () => {
  it("styles message and option hints before select receives params", () => {
    expect(
      styleSelectParams(
        {
          message: "Pick channel",
          options: [
            { value: "stable", label: "Stable", hint: "Tagged releases" },
            { value: "dev", label: "Dev" },
          ],
        },
        {
          message: (value) => `msg:${value}`,
          hint: (value) => `hint:${value}`,
        },
      ),
    ).toEqual({
      message: "msg:Pick channel",
      options: [
        { value: "stable", label: "Stable", hint: "hint:Tagged releases" },
        { value: "dev", label: "Dev" },
      ],
    });
  });

  it("keeps unhinted options unchanged", () => {
    const option = { value: "dev", label: "Dev" };
    const params = styleSelectParams(
      {
        message: "Pick channel",
        options: [option],
      },
      {
        message: (value) => `msg:${value}`,
        hint: (value) => `hint:${value}`,
      },
    );

    expect(params).toEqual({
      message: "msg:Pick channel",
      options: [{ value: "dev", label: "Dev" }],
    });
    expect(params.options[0]).toBe(option);
  });
});
