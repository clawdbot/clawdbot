import { describe, expect, it } from "vitest";
import { stripToolCallXmlTags } from "./assistant-visible-text.js";

describe("stripToolCallXmlTags", () => {
  it("strips plural function/tool wrapper XML only when the opt-in flag is enabled", () => {
    const input =
      'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix';
    expect(stripToolCallXmlTags(input)).toBe(input);
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "prefix  suffix",
    );
  });

  it("strips function_response adjacent to an opt-in stripped function_calls block", () => {
    const input = [
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response>',
      'Searching for: "what skills matter most in the age of AI"',
      "</function_response>",
      "After",
    ].join("\n");
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("\nAfter");
  });

  it("strips plural function-call XML before function_response without stripping prose examples", () => {
    const leak =
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response>raw</function_response>\nAfter';
    const prose =
      'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix';
    expect(stripToolCallXmlTags(leak, { stripFunctionResponseAfterPluralToolCalls: true })).toBe(
      "\nAfter",
    );
    expect(stripToolCallXmlTags(prose, { stripFunctionResponseAfterPluralToolCalls: true })).toBe(
      prose,
    );
  });

  it("strips function_response adjacent to an inline stripped function_calls block", () => {
    const input = [
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>',
      'Searching for: "what skills matter most in the age of AI"',
      "</function_response>",
      "After",
    ].join("\n");
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \nAfter",
    );
  });

  it("strips compact function_response after a newline-separated stripped function_calls block", () => {
    const input = [
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls>',
      "<function_response>ok</function_response>",
      "After",
    ].join("\n");
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \n\nAfter",
    );
  });

  it("strips dangling function_response adjacent to a stripped function_calls block", () => {
    const input = [
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>',
      'Searching for: "what skills matter most in the age of AI"',
    ].join("\n");
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("Checking. ");
  });

  it("strips compact dangling function_response adjacent to a stripped function_calls block", () => {
    const input =
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>raw output';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("Checking. ");
  });

  it("strips same-line function_response payloads with leading spaces", () => {
    const input =
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response> raw output</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("\nAfter");
  });

  it("strips same-line function_response payloads that start like prose", () => {
    const input =
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response> is enabled</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("\nAfter");
  });

  it("strips dangling same-line function_response payloads with leading spaces", () => {
    const input =
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response> raw output';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("");
  });

  it("strips function_response-looking prose adjacent to a stripped tool-call block", () => {
    const input =
      '<tool_call>{"name":"exec"}</tool_call>\n\n<function_response> is the response wrapper.';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("\n\n");
  });

  it("strips closed function_response-looking prose adjacent to a stripped tool-call block", () => {
    const input =
      '<tool_call>{"name":"exec"}</tool_call>\n<function_response> is the response wrapper; close it with </function_response>.';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("\n.");
  });

  it("strips adjacent function_response payloads that match explanation wording", () => {
    const input =
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response> response wrapper secret</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe("\nAfter");
  });

  it("strips compact function_response wrappers while preserving same-line prose tails", () => {
    const input =
      '<tool_call>{"name":"exec"}</tool_call>\n\n<function_response>ok</function_response> is the response wrapper.';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "\n\n is the response wrapper.",
    );
  });

  it("strips chained function_response blocks adjacent to a stripped function_calls block", () => {
    const input = [
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>',
      "first result",
      "</function_response><function_response>",
      "second result",
      "</function_response>",
      "After",
    ].join("\n");
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \nAfter",
    );
  });

  it("strips compact chained function_response blocks adjacent to a stripped function_calls block", () => {
    const input =
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>first</function_response><function_response>second</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \nAfter",
    );
  });

  it("strips compact function_response before same-line visible replies", () => {
    const input =
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>raw</function_response> Done.';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking.  Done.",
    );
  });

  it("strips antml:invoke/parameter tool call XML from visible content", () => {
    const input =
      'before <antml:invoke name="exec"><antml:parameter name="command">ls</antml:parameter></antml:invoke> after';
    expect(stripToolCallXmlTags(input)).toBe("before  after");
  });

  it("strips antml:invoke with function_call payload", () => {
    const input =
      'prefix <antml:invoke name="exec"><function_call>test</function_call></antml:invoke> suffix';
    expect(stripToolCallXmlTags(input)).toBe("prefix  suffix");
  });

  it("does not strip non-namespaced invoke tags (unrelated XML)", () => {
    const input = 'keep <invoke name="something">content</invoke> keep';
    expect(stripToolCallXmlTags(input)).toBe(input);
  });
});
