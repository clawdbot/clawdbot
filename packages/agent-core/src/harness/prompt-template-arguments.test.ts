// Agent Core tests cover prompt template argument parsing behavior.
import { describe, expect, it } from "vitest";
import { parseCommandArgs, substituteArgs } from "./prompt-template-arguments.js";

describe("prompt template arguments", () => {
  it("preserves quoted empty arguments so positional placeholders stay aligned", () => {
    expect(parseCommandArgs('first "" third')).toEqual(["first", "", "third"]);
    expect(parseCommandArgs("first '' third")).toEqual(["first", "", "third"]);
    expect(substituteArgs("$1|$2|$3", parseCommandArgs('first "" third'))).toBe("first||third");
  });
});
