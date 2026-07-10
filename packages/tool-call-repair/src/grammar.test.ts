import { describe, expect, it } from "vitest";
import { findXmlishToolCallEnd } from "./grammar.js";

describe("findXmlishToolCallEnd", () => {
  it.each([
    ["<function=get_system_info>\n</function>", true],
    ["<function=get_system_info>\n</function>\n", true],
    ["<function=get_weather><parameter=city>Tokyo</parameter></function>", true],
    ["[tool:get_system_info]</function>", false],
    ["[get_system_info]\n</function>", false],
  ] as const)("classifies %s", (raw, complete) => {
    expect(findXmlishToolCallEnd(raw)).toBe(complete ? raw.length : null);
  });
});
